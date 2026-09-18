import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { aiAgents, contacts, leads, workspaces } from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import { executeOrchestratorTools } from "./tools";

describe("orchestrator lead updates", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Orchestrator Tools Test" }).returning();
    workspaceId = workspace.id;
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
});

  it("qualifies leads only after configured required answers are persisted", async () => {
    await db.insert(aiAgents).values({
      workspaceId,
      name: "Qualification Agent",
      behaviorSettings: {
        qualification: {
          enabled: true,
          criteria: [
            { id: "service", label: "Service", question: "What service do you need?", required: true },
            { id: "urgency", label: "Urgency", question: "How soon do you need help?", required: true },
          ],
        },
      },
    });

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

