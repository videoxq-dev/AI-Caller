import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  automationDeliveries,
  automationEvents,
  automationRuns,
  automationSettings,
  contactIdentities,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  memberships,
  messages,
  notifications,
  user,
  workspaces,
} from "@/db/schema";
import { executeAutomationRun } from "./executor";
import { createAutomationRun } from "./repository";

let workspaceId = "";
let ownerId = "executor-owner";
let staffId = "executor-staff";

async function clean() {
  await db.delete(automationDeliveries);
  await db.delete(automationRuns);
  await db.delete(automationEvents);
  await db.delete(automationSettings);
  await db.delete(notifications);
  await db.delete(conversationHandlingEvents);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(leads);
  await db.delete(contactIdentities);
  await db.delete(contacts);
  await db.delete(memberships);
  await db.delete(workspaces);
  await db.delete(user);
}

describe("automation executor safety", () => {
  beforeEach(async () => {
    await clean();
    await db.insert(user).values([
      { id: ownerId, name: "Owner", email: "executor-owner@example.com", emailVerified: true },
      { id: staffId, name: "Staff", email: "executor-staff@example.com", emailVerified: true },
    ]);
    const [workspace] = await db.insert(workspaces).values({ name: "Executor Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values([
      { workspaceId, userId: ownerId, role: "OWNER" },
      { workspaceId, userId: staffId, role: "STAFF" },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("fails a deterministic invalid assignee instead of retrying forever", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Qualified Contact" }).returning();
    const [lead] = await db.insert(leads).values({
      workspaceId,
      contactId: contact.id,
      status: "QUALIFIED",
      qualificationScore: 100,
      qualificationCompletedAt: new Date(),
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      enabled: true,
      config: { assignedUserId: "removed-user", notifyInApp: true },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: lead.id,
      payload: { leadId: lead.id, contactId: contact.id, qualificationScore: 100 },
    }).returning();
    const run = await createAutomationRun({ workspaceId, eventId: event.id, key: "QUALIFIED_LEAD_ASSIGNMENT" });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "FAILED",
    });
    const [stored] = await db.select().from(automationRuns);
    expect(stored).toMatchObject({ status: "FAILED", errorCode: "AUTOMATION_ASSIGNEE_INVALID" });
  });

  it("creates independent notification rows for each workspace member", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Broadcast Contact" }).returning();
    const [lead] = await db.insert(leads).values({
      workspaceId,
      contactId: contact.id,
      status: "QUALIFIED",
      qualificationScore: 100,
      qualificationCompletedAt: new Date(),
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      enabled: true,
      config: { assignedUserId: null, notifyInApp: true },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: lead.id,
      payload: { leadId: lead.id, contactId: contact.id, qualificationScore: 100 },
    }).returning();
    const run = await createAutomationRun({ workspaceId, eventId: event.id, key: "QUALIFIED_LEAD_ASSIGNMENT" });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({ status: "COMPLETED" });
    const notices = await db.select().from(notifications);
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((notice) => notice.userId))).toEqual(new Set([ownerId, staffId]));
    expect(notices.every((notice) => notice.readAt === null)).toBe(true);
  });

  it("preserves an existing lead assignment when no fixed assignee is configured", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Already Assigned" }).returning();
    const [lead] = await db.insert(leads).values({
      workspaceId,
      contactId: contact.id,
      status: "QUALIFIED",
      qualificationScore: 100,
      qualificationCompletedAt: new Date(),
      assignedUserId: staffId,
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      enabled: true,
      config: { assignedUserId: null, notifyInApp: false },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: lead.id,
      payload: { leadId: lead.id, contactId: contact.id, qualificationScore: 100 },
    }).returning();
    const run = await createAutomationRun({ workspaceId, eventId: event.id, key: "QUALIFIED_LEAD_ASSIGNMENT" });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({ status: "SKIPPED" });
    const [storedLead] = await db.select().from(leads);
    expect(storedLead.assignedUserId).toBe(staffId);
  });

  it("marks a multi-channel run failed when any requested delivery failed", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Partial Delivery" }).returning();
    const occurredAt = new Date(Date.now() - 10 * 60_000);
    const [conversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: contact.id,
      handlingMode: "AI",
      lastMessageAt: occurredAt,
    }).returning();
    const [message] = await db.insert(messages).values({
      workspaceId,
      conversationId: conversation.id,
      channel: "SMS",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Please follow up",
      provider: "test",
      externalMessageId: "partial-delivery-inbound",
      status: "RECEIVED",
      createdAt: occurredAt,
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "MISSED_INQUIRY_RECOVERY",
      enabled: true,
      config: { delayMinutes: 5, channels: ["SMS", "WHATSAPP"], message: "Follow up" },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "INQUIRY_RECEIVED",
      aggregateType: "MESSAGE",
      aggregateId: message.id,
      payload: { messageId: message.id, conversationId: conversation.id, contactId: contact.id, channel: "SMS" },
      occurredAt,
    }).returning();
    const run = await createAutomationRun({ workspaceId, eventId: event.id, key: "MISSED_INQUIRY_RECOVERY" });
    await db.insert(automationDeliveries).values([
      { workspaceId, runId: run.id, channel: "SMS", recipient: conversation.id, status: "SENT" },
      { workspaceId, runId: run.id, channel: "WHATSAPP", recipient: conversation.id, status: "FAILED" },
    ]);

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({ status: "FAILED" });
    const [storedRun] = await db.select().from(automationRuns);
    expect(storedRun).toMatchObject({
      status: "FAILED",
      errorCode: "AUTOMATION_DELIVERY_FAILED",
      metadata: { deliverySummary: { sent: 1, skipped: 0, failed: 1 } },
    });
  });

  it("skips missed-inquiry recovery while a human owns the conversation", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Human Contact", phone: "+12025550999" }).returning();
    await db.insert(contactIdentities).values({
      workspaceId,
      contactId: contact.id,
      channel: "SMS",
      externalId: "+12025550999",
      normalizedValue: "+12025550999",
    });
    const occurredAt = new Date(Date.now() - 10 * 60_000);
    const [conversation] = await db.insert(conversations).values({
      workspaceId,
      contactId: contact.id,
      handlingMode: "HUMAN",
      assignedUserId: staffId,
      aiPausedAt: new Date(),
      lastMessageAt: occurredAt,
    }).returning();
    const [message] = await db.insert(messages).values({
      workspaceId,
      conversationId: conversation.id,
      channel: "SMS",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Still waiting",
      provider: "test",
      externalMessageId: "human-missed-inquiry",
      status: "RECEIVED",
      createdAt: occurredAt,
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "MISSED_INQUIRY_RECOVERY",
      enabled: true,
      config: { delayMinutes: 5, channels: ["SMS"], message: "Follow up" },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "INQUIRY_RECEIVED",
      aggregateType: "MESSAGE",
      aggregateId: message.id,
      payload: { messageId: message.id, conversationId: conversation.id, contactId: contact.id, channel: "SMS" },
      occurredAt,
    }).returning();
    const run = await createAutomationRun({ workspaceId, eventId: event.id, key: "MISSED_INQUIRY_RECOVERY" });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({ status: "SKIPPED" });
    expect(await db.select().from(automationDeliveries)).toHaveLength(0);
  });
});
