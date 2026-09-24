import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  appointments,
  automationDeliveries,
  automationEvents,
  automationRuns,
  contacts,
  conversationHandlingEvents,
  conversations,
  leads,
  licenses,
  memberships,
  notifications,
  user,
  workflowActionRuns,
  workflowDefinitions,
  workspaces,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";
import { classifySmsPurpose } from "@/server/sms/classification";
import { sendPreclassifiedAutomationSms } from "@/server/sms/outbound";
import { resolveWhatsAppTemplatesForWorkspace } from "@/server/providers/whatsapp/runtime";
import { sendWhatsAppConversationTemplate } from "@/server/whatsapp/outbound";
import { executeAutomationRun } from "./executor";
import { createWorkflowRun, listAutomationActivity, listWorkflowActionRuns } from "./repository";
import { createWorkflowDraft, getWorkflowVersion, publishWorkflow, setWorkflowStatus } from "./workflows";

vi.mock("@/server/sms/classification", () => ({
  classifySmsPurpose: vi.fn(),
}));

vi.mock("@/server/sms/outbound", () => ({
  sendPreclassifiedAutomationSms: vi.fn(),
}));
vi.mock("@/server/providers/whatsapp/runtime", () => ({
  resolveWhatsAppTemplatesForWorkspace: vi.fn(),
}));
vi.mock("@/server/whatsapp/outbound", () => ({
  sendWhatsAppConversationTemplate: vi.fn(),
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
  if (!run) throw new Error("Published workflow unexpectedly became inactive.");
  return { event, run };
}

describe("Phase 3C durable workflow actions", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(classifySmsPurpose).mockResolvedValue("TRANSACTIONAL");
    vi.mocked(resolveWhatsAppTemplatesForWorkspace).mockResolvedValue({
      approved: vi.fn(async () => ({
        name: "appointment_update", language: "en_US", category: "UTILITY",
        status: "APPROVED", body: "Hello {{1}}",
      })),
    } as never);
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
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: ownerId,
      source: "MANUAL",
      externalPurchaseId: "phase3c-performance",
      productCode: "PERFORMANCE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("publishes an approved WhatsApp action with registered placeholders and sends once", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_WHATSAPP", templateName: "appointment_update",
        languageCode: "en_US", variables: ["name"] },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Follow up", message: "WhatsApp sent." },
    ]);
    expect(snapshot.actions[0]).toMatchObject({
      type: "SEND_CUSTOMER_WHATSAPP", approvedCategory: "UTILITY",
    });
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    vi.mocked(sendWhatsAppConversationTemplate).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      externalMessageId: "wamid.workflow-1",
    } as never);
    const results = await Promise.all([
      executeAutomationRun(workspaceId, run.id),
      executeAutomationRun(workspaceId, run.id),
    ]);
    expect(results.some(result => result.claimed && result.status === "COMPLETED")).toBe(true);
    expect(sendWhatsAppConversationTemplate).toHaveBeenCalledOnce();
    expect(vi.mocked(sendWhatsAppConversationTemplate).mock.calls[0]?.[2]).toMatchObject({
      templateName: "appointment_update", expectedCategory: "UTILITY",
      components: [{ type: "body", parameters: [{ type: "text", text: "Priority Customer" }] }],
    });
    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => action.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect((await db.select().from(automationDeliveries)).map(delivery => delivery.channel))
      .toEqual(expect.arrayContaining(["WHATSAPP", "IN_APP"]));
  });

  it("rejects mismatched WhatsApp placeholders at publication without contacting a sender", async () => {
    const definition = await createWorkflowDraft(workspaceId, "Wrong template values", {
      trigger: "LEAD_QUALIFIED", conditions: [],
      actions: [{ type: "SEND_CUSTOMER_WHATSAPP", templateName: "appointment_update",
        languageCode: "en_US", variables: [] }],
    });
    await expect(publishWorkflow(workspaceId, definition.id)).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATE_VARIABLE_MISMATCH",
    });
    expect(sendWhatsAppConversationTemplate).not.toHaveBeenCalled();
  });

  it("continues after a blocked WhatsApp send but stops on uncertain provider acceptance", async () => {
    const { lead } = await leadContext();
    const actions = [
      { type: "SEND_CUSTOMER_WHATSAPP", templateName: "appointment_update",
        languageCode: "en_US", variables: ["name"] },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Later action", message: "Continue." },
    ];
    const { version, snapshot } = await publishedWorkflow(actions);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    vi.mocked(sendWhatsAppConversationTemplate).mockRejectedValue(
      new AppError("WHATSAPP_CONSENT_REQUIRED", "Customer declined.", 409),
    );
    await expect(executeAutomationRun(workspaceId, run.id))
      .resolves.toMatchObject({ status: "COMPLETED" });
    expect((await listWorkflowActionRuns(workspaceId, run.id)).map(action => action.status))
      .toEqual(["SKIPPED", "COMPLETED"]);
    expect((await db.select().from(automationDeliveries))
      .find(delivery => delivery.channel === "WHATSAPP")?.status).toBe("SKIPPED");
    const second = await eventAndRun(
      (await leadContext()).lead, version, snapshot.actions,
    );
    vi.mocked(sendWhatsAppConversationTemplate).mockRejectedValue(
      new Error("Meta connection reset after dispatch"),
    );
    await expect(executeAutomationRun(workspaceId, second.run.id))
      .resolves.toMatchObject({ status: "FAILED" });
    expect((await listWorkflowActionRuns(workspaceId, second.run.id)).map(action => action.status))
      .toEqual(["UNKNOWN", "PENDING"]);
    expect(await executeAutomationRun(workspaceId, second.run.id)).toMatchObject({ claimed: false });
  });

  it("rejects an unsendably long SMS before classification or publication", async () => {
    const definition = await createWorkflowDraft(workspaceId, "Overlong SMS", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "SEND_CUSTOMER_SMS", message: "A".repeat(1601) }],
    });
    await expect(publishWorkflow(workspaceId, definition.id)).rejects.toMatchObject({
      code: "WORKFLOW_SMS_TOO_LONG",
      status: 422,
    });
    expect(classifySmsPurpose).not.toHaveBeenCalled();
    expect(sendPreclassifiedAutomationSms).not.toHaveBeenCalled();
  });

  it("refuses to publish an SMS workflow when server-side purpose classification is uncertain", async () => {
    vi.mocked(classifySmsPurpose).mockResolvedValueOnce("UNCERTAIN");
    const definition = await createWorkflowDraft(workspaceId, "Unclear SMS", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, we have something for you." }],
    });

    await expect(publishWorkflow(workspaceId, definition.id)).rejects.toMatchObject({
      code: "WORKFLOW_SMS_PURPOSE_UNCERTAIN",
    });
    expect(vi.mocked(sendPreclassifiedAutomationSms)).not.toHaveBeenCalled();
  });

  it("executes assign, notify, then SMS exactly once even when two workers race", async () => {
    const { lead, conversation } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "ASSIGN_LEAD", userId: staffId },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Lead assigned", message: "Follow up now." },
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, our team will follow up shortly." },
    ]);
    expect(snapshot.actions[2]).toMatchObject({
      type: "SEND_CUSTOMER_SMS",
      classifiedPurpose: "TRANSACTIONAL",
    });
    const classificationCallsAfterPublish = vi.mocked(classifySmsPurpose).mock.calls.length;
    expect(classificationCallsAfterPublish).toBe(1);
    const { run } = await eventAndRun(lead, version, snapshot.actions);

    vi.mocked(sendPreclassifiedAutomationSms).mockImplementation(async (_workspaceId, _conversationId, input) => {
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
    expect(vi.mocked(sendPreclassifiedAutomationSms)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPreclassifiedAutomationSms).mock.calls[0]?.[2]).toMatchObject({
      classifiedPurpose: "TRANSACTIONAL",
    });
    expect(vi.mocked(classifySmsPurpose)).toHaveBeenCalledTimes(classificationCallsAfterPublish);
    expect(await db.select().from(conversationHandlingEvents)).toHaveLength(1);

    const [activity] = await listAutomationActivity(workspaceId, 10);
    expect(activity.workflow).toMatchObject({
      version: 1,
      name: "Phase 3C workflow",
    });
    expect(activity.actions).toHaveLength(3);
    expect(activity.deliveries).toHaveLength(2);
  });

  it("continues after a policy-suppressed SMS and completes a later staff notification", async () => {
    const { lead } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, thanks for speaking with us." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "SMS suppressed", message: "Follow up manually." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    vi.mocked(sendPreclassifiedAutomationSms).mockRejectedValue(
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
    vi.mocked(sendPreclassifiedAutomationSms).mockRejectedValue(new Error("connection reset after send"));

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      claimed: true,
      status: "FAILED",
    });
    expect(await executeAutomationRun(workspaceId, run.id)).toMatchObject({ claimed: false });
    expect(vi.mocked(sendPreclassifiedAutomationSms)).toHaveBeenCalledTimes(1);

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
      { type: "SEND_CUSTOMER_SMS", message: "This must never send." },
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
    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions[0]).toMatchObject({
      status: "FAILED",
      errorCode: "WORKFLOW_STAFF_INVALID",
    });
    expect(actions.map(item => item.status)).toEqual(["FAILED", "PENDING"]);
    expect(vi.mocked(sendPreclassifiedAutomationSms)).not.toHaveBeenCalled();
  });

  it("resumes after an already-completed action without repeating its side effect", async () => {
    const { lead, contact } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "NOTIFY_STAFF", userId: staffId, title: "Already completed", message: "First side effect." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Resume here", message: "Second side effect." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    const actionRows = await listWorkflowActionRuns(workspaceId, run.id);
    await db.update(workflowActionRuns).set({
      status: "COMPLETED",
      attemptCount: 1,
      completedAt: new Date(),
      result: { simulatedPriorCommit: true },
    }).where(eq(workflowActionRuns.id, actionRows[0].id));
    await db.insert(notifications).values({
      workspaceId,
      userId: staffId,
      type: "AUTOMATION_NOTIFICATION",
      title: "Already completed",
      body: "First side effect.",
      contactId: contact.id,
      metadata: {
        automationRunId: run.id,
        workflowActionRunId: actionRows[0].id,
      },
    });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "COMPLETED",
    });
    const after = await listWorkflowActionRuns(workspaceId, run.id);
    expect(after.map(action => action.attemptCount)).toEqual([1, 1]);
    const notices = await db.select().from(notifications);
    expect(notices.map(notice => notice.title).sort()).toEqual(["Already completed", "Resume here"]);
  });

  it("rejects an event whose claimed contact does not belong to the lead", async () => {
    const { lead } = await leadContext();
    const [otherContact] = await db.insert(contacts).values({
      workspaceId,
      name: "Unrelated Customer",
      phone: "+12025550177",
    }).returning();
    await db.insert(conversations).values({
      workspaceId,
      contactId: otherContact.id,
      status: "OPEN",
    });
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, here is your update." },
    ]);
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: lead.id,
      payload: {
        leadId: lead.id,
        contactId: otherContact.id,
        qualificationScore: lead.qualificationScore,
      },
    }).returning();
    const run = await createWorkflowRun({
      workspaceId,
      eventId: event.id,
      workflowVersionId: version.id,
      actions: snapshot.actions,
    });
    if (!run) throw new Error("Workflow unexpectedly inactive");
    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "FAILED",
    });
    const [stored] = await db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(stored.errorCode).toBe("WORKFLOW_EVENT_CONTACT_MISMATCH");
    expect(await db.select().from(automationDeliveries)).toHaveLength(0);
    expect(vi.mocked(sendPreclassifiedAutomationSms)).not.toHaveBeenCalled();
  });

  it("suppresses stale appointment SMS after a revision change without contacting the provider", async () => {
    const { contact, conversation } = await leadContext();
    const startsAt = new Date("2038-05-04T14:00:00Z");
    const [appointment] = await db.insert(appointments).values({
      workspaceId,
      contactId: contact.id,
      conversationId: conversation.id,
      title: "Office cleaning",
      timezone: "UTC",
      startsAt,
      endsAt: new Date("2038-05-04T15:00:00Z"),
      status: "CONFIRMED",
      revision: 0,
    }).returning();
    const definition = await createWorkflowDraft(workspaceId, "Appointment SMS", {
      trigger: "APPOINTMENT_RESCHEDULED",
      conditions: [],
      actions: [{
        type: "SEND_CUSTOMER_SMS",
        message: "Hi {{name}}, your {{service}} is {{appointment_date}} at {{appointment_time}}.",
      }],
    });
    const version = await publishWorkflow(workspaceId, definition.id);
    const stored = await getWorkflowVersion(workspaceId, version.id);
    if (!stored) throw new Error("Published workflow missing");
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "APPOINTMENT_RESCHEDULED",
      aggregateType: "APPOINTMENT",
      aggregateId: appointment.id,
      payload: {
        appointmentId: appointment.id,
        startsAt: startsAt.toISOString(),
        revision: 0,
      },
    }).returning();
    const run = await createWorkflowRun({
      workspaceId, eventId: event.id, workflowVersionId: version.id,
      actions: stored.snapshot.actions,
    });
    if (!run) throw new Error("Workflow unexpectedly inactive");

    await db.update(appointments).set({
      revision: 1,
      startsAt: new Date("2038-05-05T14:00:00Z"),
      endsAt: new Date("2038-05-05T15:00:00Z"),
    }).where(eq(appointments.id, appointment.id));
    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "SKIPPED",
    });
    const [action] = await listWorkflowActionRuns(workspaceId, run.id);
    expect(action).toMatchObject({
      status: "SKIPPED",
      errorCode: "APPOINTMENT_REVISION_CHANGED",
    });
    expect(await db.select().from(automationDeliveries)).toHaveLength(0);
    expect(vi.mocked(sendPreclassifiedAutomationSms)).not.toHaveBeenCalled();
  });

  it("recovers an interrupted claimed SMS as UNKNOWN without sending again", async () => {
    const { lead, conversation } = await leadContext();
    const { version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, your update is ready." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Later action", message: "Do not run after uncertain SMS." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    const [smsAction] = await listWorkflowActionRuns(workspaceId, run.id);
    const stale = new Date(Date.now() - 6 * 60_000);
    await db.update(automationRuns).set({
      status: "RUNNING",
      startedAt: stale,
    }).where(eq(automationRuns.id, run.id));
    await db.update(workflowActionRuns).set({
      status: "RUNNING",
      startedAt: stale,
      attemptCount: 1,
    }).where(eq(workflowActionRuns.id, smsAction.id));
    await db.insert(automationDeliveries).values({
      workspaceId,
      runId: run.id,
      actionRunId: smsAction.id,
      channel: "SMS",
      recipient: conversation.id,
      status: "PENDING",
    });

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "FAILED",
    });
    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => action.status)).toEqual(["UNKNOWN", "PENDING"]);
    const [delivery] = await db.select().from(automationDeliveries);
    expect(delivery.status).toBe("UNKNOWN");
    expect(vi.mocked(sendPreclassifiedAutomationSms)).not.toHaveBeenCalled();
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("lets in-flight SMS complete after pause but cancels subsequent workflow actions", async () => {
    const { lead } = await leadContext();
    const { definition, version, snapshot } = await publishedWorkflow([
      { type: "SEND_CUSTOMER_SMS", message: "Hi {{name}}, an update for you." },
      { type: "NOTIFY_STAFF", userId: staffId, title: "Never after pause", message: "Do not deliver." },
    ]);
    const { run } = await eventAndRun(lead, version, snapshot.actions);
    let signalSend!: () => void;
    let completeSend!: (value: { id: string; externalMessageId: string }) => void;
    const beganSend = new Promise<void>(resolve => { signalSend = resolve; });
    const pendingProvider = new Promise<{ id: string; externalMessageId: string }>(resolve => {
      completeSend = resolve;
    });
    vi.mocked(sendPreclassifiedAutomationSms).mockImplementation(async () => {
      signalSend();
      return await pendingProvider as never;
    });
    const executing = executeAutomationRun(workspaceId, run.id);
    await beganSend;
    await setWorkflowStatus(workspaceId, definition.id, "PAUSED");
    completeSend({
      id: "44444444-4444-4444-8444-444444444444",
      externalMessageId: "accepted-before-pause",
    });

    await expect(executing).resolves.toMatchObject({ status: "CANCELLED" });
    const [storedRun] = await db.select().from(automationRuns)
      .where(eq(automationRuns.id, run.id));
    expect(storedRun.status).toBe("CANCELLED");
    const actions = await listWorkflowActionRuns(workspaceId, run.id);
    expect(actions.map(action => action.status)).toEqual(["COMPLETED", "CANCELLED"]);
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(vi.mocked(sendPreclassifiedAutomationSms)).toHaveBeenCalledTimes(1);
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
    vi.mocked(sendPreclassifiedAutomationSms).mockImplementation(async () => ({
      id: ids[index++],
      externalMessageId: `sms-phase3c-${index}`,
    } as never));

    await expect(executeAutomationRun(workspaceId, run.id)).resolves.toMatchObject({
      status: "COMPLETED",
    });
    const deliveries = await db.select().from(automationDeliveries);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map(delivery => delivery.actionRunId)).size).toBe(2);
    const keys = vi.mocked(sendPreclassifiedAutomationSms).mock.calls.map(call => call[2].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
