import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { enqueueUniqueJob } from "@/server/jobs";
import {
  automationEvents,
  automationRuns,
  automationSettings,
  licenses,
  memberships,
  notifications,
  user,
  workspaces,
} from "@/db/schema";
import { dispatchAutomationEvent } from "./dispatcher";
import { executeAutomationRun } from "./executor";
import { createWorkflowDraft, publishWorkflow } from "./workflows";

vi.mock("@/server/jobs", () => ({
  enqueueUniqueJob: vi.fn(async () => "job"),
  enqueueUniqueJobAt: vi.fn(async () => "job"),
}));

let workspaceId = "";

describe("automation dispatcher", () => {
  beforeEach(async () => {
    await db.delete(automationRuns);
    await db.delete(automationEvents);
    await db.delete(automationSettings);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);
    await db.insert(user).values({ id: "automation-owner", name: "Owner", email: "automation@example.com", emailVerified: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Automation Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: "automation-owner", role: "OWNER" });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: "automation-owner",
      source: "MANUAL",
      externalPurchaseId: "dispatcher-performance",
      productCode: "PERFORMANCE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("does nothing while a recipe is disabled", async () => {
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "lead-1",
    }).returning();

    await expect(dispatchAutomationEvent(workspaceId, event.id)).resolves.toMatchObject({ runs: 0 });
    expect(await db.select().from(automationRuns)).toHaveLength(0);
  });

  it("creates exactly one run when the same event is dispatched twice", async () => {
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
      aggregateId: "lead-2",
    }).returning();

    await dispatchAutomationEvent(workspaceId, event.id);
    await dispatchAutomationEvent(workspaceId, event.id);

    const runs = await db.select().from(automationRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "QUALIFIED_LEAD_ASSIGNMENT", occurrenceKey: "default" });
  });

  it("creates deterministic first and second reminder occurrences", async () => {
    await db.insert(automationSettings).values({
      workspaceId,
      key: "APPOINTMENT_REMINDER",
      enabled: true,
      config: {
        firstMinutesBefore: 1440,
        secondMinutesBefore: 120,
        channels: ["SMS"],
        message: "Reminder",
        whatsappTemplateName: null,
        whatsappTemplateLanguage: "en_US",
      },
    });
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "APPOINTMENT_CONFIRMED",
      aggregateType: "APPOINTMENT",
      aggregateId: "11111111-1111-4111-8111-111111111111",
      payload: { appointmentId: "11111111-1111-4111-8111-111111111111", startsAt },
    }).returning();

    await dispatchAutomationEvent(workspaceId, event.id);
    const runs = await db.select().from(automationRuns);
    expect(runs.map((run) => run.occurrenceKey).sort()).toEqual(["before:120", "before:1440"]);
    expect(runs.every((run) => run.scheduledFor instanceof Date)).toBe(true);
    expect(runs.every((run) => run.metadata.expectedAppointmentRevision === 0)).toBe(true);
  });


  it("persists the appointment revision with each scheduled reminder", async () => {
    await db.insert(automationSettings).values({
      workspaceId,
      key: "APPOINTMENT_REMINDER",
      enabled: true,
      config: {
        firstMinutesBefore: 1440, secondMinutesBefore: null,
        channels: ["SMS"], message: "Reminder",
        whatsappTemplateName: null, whatsappTemplateLanguage: "en_US",
      },
    });
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const [event] = await db.insert(automationEvents).values({
      workspaceId, type: "APPOINTMENT_RESCHEDULED",
      aggregateType: "APPOINTMENT", aggregateId: "11111111-1111-4111-8111-111111111111",
      payload: { appointmentId: "11111111-1111-4111-8111-111111111111", startsAt, revision: 7 },
    }).returning();

    await dispatchAutomationEvent(workspaceId, event.id);
    const [run] = await db.select().from(automationRuns);
    expect(run.metadata.expectedAppointmentRevision).toBe(7);
    expect(run.metadata.expectedStartsAt).toBe(startsAt);
  });

  it("does not dispatch published custom workflows after Performance is revoked", async () => {
    const definition = await createWorkflowDraft(workspaceId, "Performance gated", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "NOTIFY_STAFF", title: "Lead ready", message: "Contact the customer." }],
    });
    await publishWorkflow(workspaceId, definition.id);
    await db.update(licenses).set({ status: "REFUNDED" }).where(eq(licenses.workspaceId, workspaceId));
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "performance-revoked",
      payload: { qualificationScore: 90 },
    }).returning();

    await expect(dispatchAutomationEvent(workspaceId, event.id)).resolves.toMatchObject({ runs: 0 });
    expect(await db.select().from(automationRuns)).toHaveLength(0);
  });

  it("matches a published threshold workflow without duplicating runs or changing legacy recipes", async () => {
    const definition = await createWorkflowDraft(workspaceId, "Lead threshold", {
      trigger: "LEAD_QUALIFIED",
      conditions: [{ field: "qualificationScore", operator: "GTE", value: 75 }],
      actions: [{ type: "NOTIFY_STAFF", title: "Lead ready", message: "Contact the customer." }],
    });
    const version = await publishWorkflow(workspaceId, definition.id);
    const [high, low, historic] = await db.insert(automationEvents).values([
      { workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
        aggregateId: "high", payload: { qualificationScore: 85 } },
      { workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
        aggregateId: "low", payload: { qualificationScore: 40 } },
      { workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
        aggregateId: "historic", payload: { qualificationScore: 95 },
        occurredAt: new Date(Date.now() - 60_000) },
    ]).returning();

    await Promise.all([
      dispatchAutomationEvent(workspaceId, high.id),
      dispatchAutomationEvent(workspaceId, high.id),
    ]);
    await dispatchAutomationEvent(workspaceId, low.id);
    await dispatchAutomationEvent(workspaceId, historic.id);
    const runs = await db.select().from(automationRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      eventId: high.id, workflowVersionId: version.id, key: null,
    });
    await expect(executeAutomationRun(workspaceId, runs[0].id)).resolves.toMatchObject({
      claimed: true, status: "COMPLETED",
    });
    const notices = await db.select().from(notifications);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("Lead ready");
    expect(notices[0].body).toBe("Contact the customer.");
  });

  it("leaves an event recoverable if enqueue fails after the run is committed", async () => {
    await db.insert(automationSettings).values({
      workspaceId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      enabled: true,
      config: { assignedUserId: null, notifyInApp: true },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId, type: "LEAD_QUALIFIED",
      aggregateType: "LEAD", aggregateId: "lead-recovery",
    }).returning();

    vi.mocked(enqueueUniqueJob).mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(dispatchAutomationEvent(workspaceId, event.id)).rejects.toThrow("queue unavailable");
    const [undispatched] = await db.select().from(automationEvents);
    expect(undispatched.dispatchedAt).toBeNull();
    expect(await db.select().from(automationRuns)).toHaveLength(1);

    await dispatchAutomationEvent(workspaceId, event.id);
    const [recovered] = await db.select().from(automationEvents);
    expect(recovered.dispatchedAt).not.toBeNull();
    expect(await db.select().from(automationRuns)).toHaveLength(1);
  });

  it("creates one run even when two workers dispatch the same event concurrently", async () => {
    await db.insert(automationSettings).values({
      workspaceId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      enabled: true,
      config: { assignedUserId: null, notifyInApp: true },
    });
    const [event] = await db.insert(automationEvents).values({
      workspaceId, type: "LEAD_QUALIFIED",
      aggregateType: "LEAD", aggregateId: "lead-concurrent",
    }).returning();

    await Promise.all([
      dispatchAutomationEvent(workspaceId, event.id),
      dispatchAutomationEvent(workspaceId, event.id),
    ]);
    expect(await db.select().from(automationRuns)).toHaveLength(1);
  });
});
