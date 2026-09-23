import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  automationDeliveries,
  automationEvents,
  automationRuns,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  memberships,
  notifications,
  user,
  workflowActionRuns,
  workflowDefinitions,
  workspaces,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { sendSmsConversationText } from "@/server/sms/outbound";
import { executeAutomationRun } from "./executor";
import { createWorkflowRun, listWorkflowActionRuns } from "./repository";
import { createWorkflowDraft, getWorkflowVersion, publishWorkflow } from "./workflows";

vi.mock("@/server/sms/outbound", () => ({
  sendSmsConversationText: vi.fn(),
}));

const ownerId = "phase3c-owner";
const staffId = "phase3c-staff";
let workspaceId = "";

async function clean() {
  await db.delete(automationDeliveries);
  await db.delete(automationRuns);
  await db.delete(automationEvents);
  await db.delete(notifications);
  await db.delete(conversationHandlingEvents);
  await db.delete(conversations);
  await db.delete(leads);
  await db.delete(contacts);
  await db.delete(workflowDefinitions);
  await db.delete(memberships);
  await db.delete(workspaces);
  await db.delete(user);
}

async function leadContext() {
  const [contact] = await db.insert(contacts).values({
    workspaceId,
    name: "Priority Customer",
    phone: "+12025550123",
  }).returning();
  const [conversation] = await db.insert(conversations).values({
    workspaceId,
    contactId: contact.id,
    status: "OPEN",
    handlingMode: "AI",
  }).returning();
  const [lead] = await db.insert(leads).values({
    workspaceId,
    contactId: contact.id,
    status: "QUALIFIED",
    qualificationScore: 95,
    qualificationCompletedAt: new Date(),
  }).returning();
  return { contact, conversation, lead };
}

async function publishedWorkflow(actions: Array<Record<string, unknown>>) {
  const definition = await createWorkflowDraft(workspaceId, "Phase 3C workflow", {
    trigger: "LEAD_QUALIFIED",
    conditions: [{ field: "qualificationScore", operator: "GTE", value: 80 }],
    actions,
  });
  const version = await publishWorkflow(workspaceId, definition.id);
  const stored = await getWorkflowVersion(workspaceId, version.id);
  if (!stored) throw new Error("Published workflow version missing");
  return { definition, version, snapshot: stored.snapshot };
}

async function eventAndRun(
  lead: { id: string; contactId: string; qualificationScore: number },
  version: { id: string },
  actions: Array<{ type: string }>,
) {
  const [event] = await db.insert(automationEvents).values({
    workspaceId,
    type: "LEAD_QUALIFIED",
    aggregateType: "LEAD",
    aggregateId: lead.id,
    payload: {
      leadId: lead.id,
      contactId: lead.contactId,
      qualificationScore: lead.qualificationScore,
    },
  }).returning();
  const run = await createWorkflowRun({
    workspaceId,
    eventId: event.id,
    workflowVersionId: version.id,
    actions,
  });
  return { event, run };
}

describe("Phase 3C durable workflow actions", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await clean();
    await db.insert(user).values([
      { id: ownerId, name: "Owner", email: "phase3c-owner@example.com", emailVerified: true },
      { id: staffId, name: "Staff", email: "phase3c-staff@example.com", emailVerified: true },
    ]);
    const [workspace] = await db.insert(workspaces).values({ name: "Phase 3C Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values([
      { workspaceId, userId: ownerId, role: "OWNER" },
      { workspaceId, userId: staffId, role: "STAFF" },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("executes assign, notify, then SMS exactly once even when two workers race", async () => {
    const { lead, conversation } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "ASSIGN_LEAD", userId: staffId },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Lead assigned", message: "Follow up now." },
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, our team will follow up shortly." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);

    vi.mocked(sendSmsConversationText).mockImplementation(async (_workspaceId, _conversationId, input) => {
      const [storedLead] = await db.select().from(leads);
      expect(storedLead.assignedUserId).toBe(staffId);
      expect(await db.select().from(notifications)).toHaveLength(1);
      expect(input.idempotencyKey).toBeTruthy();
      return {
        id: "11111111-1111-4111-8111-111111111111",
        externalMessageId: "sms-phase3c-1",
      } as never;
    });

    const results = await Promise.all([
      executeAutomationRun(workspaceId, run.id),
      executeAutomationRun(workspaceId, run.id),
    ]);
    expect(results.some(result => result.claimed === true && result.status === "COMPLETED")).toBe(true);
    expect(results.some(result => result.claimed === false)).toBe(true);

    const [storedLead] = await db.select().from(leads);
    const [storedConversation] = await db.select().from(conversations);
    expect(storedLead.assignedUserId).toBe(staffId);
    expect(storedConversation.id).toBe(conversation.id);
    expect(storedConversation.assignedUserId).toBe(staffId);

    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => [action.actionIndex, action.actionType, action.status, action.attemptCount])).toEqual([
      [0, "ASSIGN_LEAD", "COMPLETED", 1],
      [1, "NOTIFY_STAFF", "COMPLETED", 1],
      [2, "SEND_CUSTOMER_SMS", "COMPLETED", 1],
    ]);
    const deliveries = await db.select().from(automationDeliveries);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(delivery => delivery.actionRunId !== null)).toBe(true);
    expect(new Set(deliveries.map(delivery => delivery.channel))).toEqual(new Set(["IN_APP", "SMS"]));
    expect(vi.mocked(sendSmsConversationText)).toHaveBeenCalledTimes(1);
    expect(await db.select().from(conversationHandlingEvents)).toHaveLength(1);
  });

  it("continues after a policy-suppressed SMS and completes a later staff notification", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, thanks for speaking with us." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "SMS suppressed", message: "Follow up manually." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    vi.mocked(sendSmsConversationText).mockRejectedValue(
      new AppError("SMS_CONSENT_REQUIRED", "Customer opted out.", 409),
    );

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "COMPLETED",
    });
    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => action.status)).toEqual(["SKIPPED", "COMPLETED"]);
    expect(actions[0].errorCode).toBe("SMS_CONSENT_REQUIRED");
    expect(await db.select().from(notifications)).toHaveLength(1);
    const [delivery] = await db.select().from(automationDeliveries)
      .where(eq(automationDeliveries.channel, "SMS"));
    expect(delivery.status).toBe("SKIPPED");
  });

  it("marks an ambiguous SMS UNKNOWN, stops later actions, and never automatically resends it", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, we will follow up." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Should not run", message: "Do not create this." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    vi.mocked(sendSmsConversationText).mockRejectedValue(new Error("connection reset after send"));

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "FAILED",
    });
    expect(await executeAutomationRun(workspaceId, run.id)).toMatchObject({ claimed: false });
    expect(vi.mocked(sendSmsConversationText)).toHaveBeenCalledTimes(1);

    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => action.status)).toEqual(["UNKNOWN", "PENDING"]);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [delivery] = await db.select().from(automationDeliveries);
    expect(delivery.status).toBe("UNKNOWN");
    const [storedRun] = await db.select().from(automationRuns);
    expect(storedRun.errorCode).toBe("WORKFLOW_ACTION_UNKNOWN");
  });

  it("fails safely if a configured assignee is removed after publication", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "ASSIGN_LEAD", userId: staffId },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    await db.delete(memberships).where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.userId, staffId),
    ));

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "FAILED",
    });
    const [storedLead] = await db.select().from(leads);
    expect(storedLead.assignedUserId).toBeNull();
    const [action] = await db.select().from(workflowActionRuns);
    expect(action).toMatchObject({
      status: "FAILED",
      errorCode: "WORKFLOW_STAFF_INVALID",
    });
  });

  it("allows two intentional SMS actions to the same conversation without delivery identity collisions", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "First message for {{name}}." },
      { type: "SEND_CUSTOMER_SMS", message: "Second message for {{name}}." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    const ids = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    let index = 0;
    vi.mocked(sendSmsConversationText).mockImplementation(async () => ({
      id: ids[index++],
      externalMessageId: `sms-phase3c-${index}`,
    } as never));

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "COMPLETED",
    });
    const deliveries = await db.select().from(automationDeliveries);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map(delivery => delivery.actionRunId)).size).toBe(2);
    const keys = vi.mocked(sendSmsConversationText).mock.calls.map(call => call[2].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
