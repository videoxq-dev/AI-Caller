import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { AppError } from "@/server/http/errors";
import {
  appointments,
  automationDeliveries,
  automationEvents,
  automationRuns,
  automationSettings,
  contactIdentities,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  licenses,
  memberships,
  messages,
  notifications,
  user,
  workspaces,
} from "@/db/schema";
import { deliveryFailureStatus, executeAutomationRun } from "./executor";
import { createAutomationRun, createWorkflowRun } from "./repository";
import { createWorkflowDraft, publishWorkflow, updateWorkflowDraft } from "./workflows";

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
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: ownerId,
      source: "MANUAL",
      externalPurchaseId: "executor-performance",
      productCode: "PERFORMANCE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("records policy-blocked legacy SMS as SKIPPED rather than unknown delivery", () => {
    for (const code of [
      "SMS_CONSENT_REQUIRED",
      "SMS_CAMPAIGN_NOT_APPROVED",
      "SMS_CAMPAIGN_PURPOSE_NOT_APPROVED",
      "SMS_CAMPAIGN_REVIEW_REQUIRED",
      "SMS_REGISTRATION_REQUIRED",
      "SMS_UNSAFE_LINK",
      "SMS_TOO_LONG",
    ]) {
      expect(deliveryFailureStatus(new AppError(code, "Blocked before dispatch.", 409))).toBe("SKIPPED");
    }
    expect(deliveryFailureStatus(
      new AppError("SMS_ACCEPTED_FINALIZATION_FAILED", "Carrier may have accepted.", 503),
    )).toBe("UNKNOWN");
    expect(deliveryFailureStatus(
      new AppError("HUMAN_TAKEOVER_REQUIRED", "Take over the conversation.", 409),
    )).toBe("FAILED");
  });

  it("skips an already queued custom workflow if Performance is revoked before execution", async () => {
    const definition = await createWorkflowDraft(workspaceId, "Queued custom workflow", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "NOTIFY_STAFF", title: "Lead ready", message: "Contact the customer." }],
    });
    const version = await publishWorkflow(workspaceId, definition.id);
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "queued-before-refund",
      payload: { qualificationScore: 90 },
    }).returning();
    const run = await createWorkflowRun({
      workspaceId,
      eventId: event.id,
      workflowVersionId: version.id,
      actions: version.snapshot.actions,
    });
    if (!run) throw new Error("Expected custom workflow run.");

    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.workspaceId, workspaceId));
    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "SKIPPED",
    });

    const [stored] = await db.select().from(automationRuns);
    expect(stored).toMatchObject({ status: "SKIPPED", metadata: { reason: "PERFORMANCE_REQUIRED" } });
    expect(await db.select().from(notifications)).toHaveLength(0);
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

  it("does not resurrect the original reminder when an appointment returns to its old time", async () => {
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Round-trip Customer" }).returning();
    const [conversation] = await db.insert(conversations).values({
      workspaceId, contactId: contact.id,
    }).returning();
    const startsAt = new Date("2037-10-02T14:00:00.000Z");
    const [appointment] = await db.insert(appointments).values({
      workspaceId, contactId: contact.id, conversationId: conversation.id,
      title: "Cleaning", timezone: "UTC", startsAt,
      endsAt: new Date("2037-10-02T15:00:00.000Z"),
      status: "CONFIRMED", revision: 2,
    }).returning();
    await db.insert(automationSettings).values({
      workspaceId,
      key: "APPOINTMENT_REMINDER",
      enabled: true,
      config: { channels: ["SMS"], firstMinutesBefore: 1440, secondMinutesBefore: null,
        message: "Reminder", whatsappTemplateName: null, whatsappTemplateLanguage: "en_US" },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId, type: "APPOINTMENT_CONFIRMED", aggregateType: "APPOINTMENT",
      aggregateId: appointment.id,
      payload: { appointmentId: appointment.id, startsAt: startsAt.toISOString(), revision: 0 },
    }).returning();
    const run = await createAutomationRun({
      workspaceId, eventId: event.id, key: "APPOINTMENT_REMINDER",
      metadata: { expectedStartsAt: startsAt.toISOString(), expectedAppointmentRevision: 0 },
    });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "SKIPPED",
    });
    expect(await db.select().from(automationDeliveries)).toHaveLength(0);
  });

  it("executes an immutable workflow version once, even after its draft is changed", async () => {
    const original = {
      trigger: "LEAD_QUALIFIED",
      conditions: [{ field: "qualificationScore", operator: "GTE", value: 80 }],
      actions: [{ type: "NOTIFY_STAFF", title: "Qualified lead", message: "Original published message." }],
    };
    const definition = await createWorkflowDraft(workspaceId, "High-scoring leads", original);
    const firstVersion = await publishWorkflow(workspaceId, definition.id);
    const [event] = await db.insert(automationEvents).values({
      workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
      aggregateId: "custom-lead", payload: { qualificationScore: 95 },
    }).returning();
    const run = await createWorkflowRun({
      workspaceId, eventId: event.id, workflowVersionId: firstVersion.id,
      actions: original.actions,
    });
    if (!run) throw new Error("Published workflow unexpectedly became inactive.");
    const duplicate = await createWorkflowRun({
      workspaceId, eventId: event.id, workflowVersionId: firstVersion.id,
      actions: original.actions,
    });
    expect(duplicate?.id).toBe(run.id);

    await updateWorkflowDraft(workspaceId, definition.id, "High-scoring leads", {
      ...original, actions: [{ type: "NOTIFY_STAFF", title: "New message", message: "New published message." }],
    });
    const nextVersion = await publishWorkflow(workspaceId, definition.id);
    expect(nextVersion.version).toBe(2);

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true, status: "COMPLETED",
    });
    expect(await executeAutomationRun(workspaceId, run.id)).toMatchObject({ claimed: false });
    const notices = await db.select().from(notifications);
    expect(notices).toHaveLength(2);
    expect(notices.map(notice => notice.body)).toEqual([
      "Original published message.", "Original published message.",
    ]);
    expect(await db.select().from(automationDeliveries)).toHaveLength(1);
    const [recorded] = await db.select().from(automationRuns);
    expect(recorded.workflowVersionId).toBe(firstVersion.id);
  });
});
