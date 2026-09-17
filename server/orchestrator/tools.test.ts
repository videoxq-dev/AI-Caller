import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { contacts, leads, workspaces } from "@/db/schema";
import { executeOrchestratorTools } from "./tools";

describe("orchestrator lead updates", () => {
  let workspaceId = "";
  let contactId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Orchestrator Tools Test" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Ada" }).returning();
    contactId = contact.id;
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

    await executeOrchestratorTools(workspaceId, "unused-conversation", contactId, {
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

    await executeOrchestratorTools(workspaceId, "unused-conversation", contactId, {
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
