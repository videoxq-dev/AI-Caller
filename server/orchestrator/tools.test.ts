import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { aiAgents, contacts, leads, workspaces } from "@/db/schema";
import { listAppointments } from "@/server/domain/core/repository";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { executeOrchestratorTools } from "./tools";
import { setWorkspaceAgentCapabilities } from "@/server/agent/service";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";

describe("orchestrator lead updates", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Orchestrator Tools Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(aiAgents).values({ workspaceId, status: "ACTIVE", name: "Mia" });
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Ada" }).returning();
    contactId = contact.id;
    const conversation = await getOrCreateOpenConversation(workspaceId, contactId);
    conversationId = conversation.id;
    await appendMessage(workspaceId, conversationId, {
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Follow-up question",
      provider: null,
      externalMessageId: null,
      status: "RECEIVED",
      metadata: {},
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("does not downgrade a booked lead when a later AI turn qualifies intent", async () => {
    await db.insert(leads).values({
      workspaceId,
      contactId,
      status: "BOOKED",
      intent: "Appointment booking",
      serviceRequested: "Consultation",
      source: "WEBCHAT",
    });

    await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      lead: {
        status: "QUALIFIED",
        intent: "Asked a follow-up pricing question",
        serviceRequested: "Consultation",
      },
      action: { type: "NONE" },
    });

    const [lead] = await db.select().from(leads).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.contactId, contactId),
    ));
    expect(lead.status).toBe("BOOKED");
    expect(lead.intent).toBe("Asked a follow-up pricing question");
  });

  it("does not downgrade qualified leads back to new", async () => {
    await db.insert(leads).values({
      workspaceId,
      contactId,
      status: "QUALIFIED",
      intent: "Qualified intent",
      source: "WEBCHAT",
    });

    await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      lead: { status: "NEW", intent: "Follow-up" },
      action: { type: "NONE" },
    });

    const [lead] = await db.select().from(leads).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.contactId, contactId),
    ));
    expect(lead.status).toBe("QUALIFIED");
  });

  it("qualifies leads only after configured required answers are persisted", async () => {
    await db.update(aiAgents).set({
      behaviorSettings: {
        qualification: {
          enabled: true,
          criteria: [
            { id: "service", label: "Service", question: "What service do you need?", required: true },
            { id: "urgency", label: "Urgency", question: "How soon do you need help?", required: true },
          ],
        },
      },
    }).where(eq(aiAgents.workspaceId, workspaceId));

    await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      lead: { status: "QUALIFIED", intent: "Service inquiry" },
      action: {
        type: "QUALIFY_LEAD",
        answers: [{ criterionId: "service", answer: "Commercial HVAC repair" }],
      },
    });

    let [lead] = await db.select().from(leads).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.contactId, contactId),
    ));
    expect(lead.status).toBe("NEW");
    expect(lead.qualificationScore).toBe(50);
    expect(lead.qualificationData).toEqual({ service: "Commercial HVAC repair" });
    expect(lead.qualificationCompletedAt).toBeNull();

    await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      action: {
        type: "QUALIFY_LEAD",
        answers: [{ criterionId: "urgency", answer: "Today" }],
      },
    });

    [lead] = await db.select().from(leads).where(and(
      eq(leads.workspaceId, workspaceId),
      eq(leads.contactId, contactId),
    ));
    expect(lead.status).toBe("QUALIFIED");
    expect(lead.qualificationScore).toBe(100);
    expect(lead.qualificationData).toEqual({ service: "Commercial HVAC repair", urgency: "Today" });
    expect(lead.qualificationCompletedAt).toBeInstanceOf(Date);
  });
  it("executes availability and a confirmed in-app booking with no connected calendar", async () => {
    await saveBusinessSetup(workspaceId, {
      businessName: "Office Cleaning", timezone: "UTC", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "18:00",
      })),
    });
    const availability = await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      action: { type: "CHECK_AVAILABILITY", startsAt: "2030-09-23T08:00:00Z",
        endsAt: "2030-09-23T18:00:00Z", timezone: "UTC", durationMinutes: 240 },
    });
    expect(availability.kind).toBe("availability");
    expect(availability.data.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ startsAt: "2030-09-23T10:00:00.000Z" }),
    ]));
    const booked = await executeOrchestratorTools(workspaceId, conversationId, contactId, {
      action: { type: "BOOK_APPOINTMENT", startsAt: "2030-09-23T10:00:00Z",
        endsAt: "2030-09-23T14:00:00Z", timezone: "UTC", title: "Office Cleaning" },
    });
    expect(booked).toMatchObject({ kind: "booking", data: { status: "CONFIRMED" } });
    expect((await listAppointments(workspaceId)).total).toBe(1);
  });

  it("denies a forged booking before touching the calendar or customer record", async () => {
    await setWorkspaceAgentCapabilities(workspaceId, { ...defaultAgentCapabilities, BOOK_APPOINTMENT: false });
    await expect(executeOrchestratorTools(workspaceId, conversationId, contactId, {
      contact: { name: "Changed by forged model" },
      action: {
        type: "BOOK_APPOINTMENT",
        startsAt: "2026-09-22T10:00:00Z", endsAt: "2026-09-22T10:30:00Z",
        timezone: "UTC", title: "Unauthorized booking",
      },
    })).rejects.toMatchObject({ code: "AGENT_ACTION_DISABLED", status: 403 });
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact.name).toBe("Ada");
  });

  it("denies metadata updates when contact permission is disabled", async () => {
    await setWorkspaceAgentCapabilities(workspaceId, { ...defaultAgentCapabilities, UPDATE_CONTACT: false });
    await expect(executeOrchestratorTools(workspaceId, conversationId, contactId, {
      contact: { name: "Not permitted" }, action: { type: "NONE" },
    })).rejects.toMatchObject({ code: "AGENT_ACTION_DISABLED" });
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact.name).toBe("Ada");
  });

});
