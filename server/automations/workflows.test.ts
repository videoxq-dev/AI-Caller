import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  automationEvents,
  automationRuns,
  licenses,
  memberships,
  user,
  workflowActionRuns,
  workflowDefinitions,
  workflowVersions,
  workspaces,
} from "@/db/schema";
import {
  createWorkflowDraft,
  getWorkflowVersion,
  listPublishedWorkflowVersions,
  matchesWorkflow,
  publishWorkflow,
  setWorkflowStatus,
  updateWorkflowDraft,
  workflowDefinitionSchema,
} from "./workflows";
import { createWorkflowRun } from "./repository";

const original = {
  trigger: "LEAD_QUALIFIED" as const,
  match: "ALL" as const,
  conditions: [{ field: "qualificationScore" as const, operator: "GTE" as const, value: 75 }],
  actions: [{ type: "NOTIFY_STAFF" as const, title: "High-priority lead", message: "Review this lead." }],
};
let workspaceId = "";

describe("versioned deterministic workflows", () => {
  beforeEach(async () => {
    await db.delete(automationRuns);
    await db.delete(automationEvents);
    await db.delete(workflowVersions);
    await db.delete(workflowDefinitions);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);
    await db.insert(user).values({ id: "workflow-owner", name: "Owner", email: "workflow-owner@example.com", emailVerified: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Workflow Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: "workflow-owner", role: "OWNER" });
    await db.insert(licenses).values({
      workspaceId,
      purchaserUserId: "workflow-owner",
      source: "MANUAL",
      externalPurchaseId: "workflow-performance",
      productCode: "PERFORMANCE",
      status: "ACTIVE",
      purchasedAt: new Date(),
    });
  });

  afterAll(async () => { await closeDatabase(); });

  it("only accepts bounded, supported conditions and registered actions", () => {
    expect(() => workflowDefinitionSchema.parse({
      ...original, conditions: [{ field: "qualificationScore", operator: "GTE", value: 75 }],
      executionMode: "AI_ASSISTED",
    })).toThrow();
    expect(() => workflowDefinitionSchema.parse({
      ...original, actions: [{ type: "CALL_URL", url: "http://localhost/admin" }],
    })).toThrow();
    expect(() => workflowDefinitionSchema.parse({
      ...original, trigger: "APPOINTMENT_CONFIRMED",
    })).toThrow();
    expect(matchesWorkflow(workflowDefinitionSchema.parse(original), {
      type: "LEAD_QUALIFIED", payload: { qualificationScore: 80 },
    })).toBe(true);
    expect(matchesWorkflow(workflowDefinitionSchema.parse(original), {
      type: "LEAD_QUALIFIED", payload: { qualificationScore: "80" },
    })).toBe(false);
    expect(matchesWorkflow(workflowDefinitionSchema.parse(original), {
      type: "LEAD_QUALIFIED", payload: {},
    })).toBe(false);
  });

  it("rejects oversized workflows, incompatible actions, invalid staff, and unsupported SMS variables", async () => {
    expect(() => workflowDefinitionSchema.parse({
      ...original,
      actions: Array.from({ length: 6 }, (_, index) => ({
        type: "NOTIFY_STAFF",
        title: `Notice ${index}`,
        message: "Review this.",
      })),
    })).toThrow();

    expect(() => workflowDefinitionSchema.parse({
      trigger: "APPOINTMENT_CONFIRMED",
      conditions: [],
      actions: [{ type: "ASSIGN_LEAD", userId: "workflow-owner" }],
    })).toThrow();

    const invalidVariable = await createWorkflowDraft(workspaceId, "Bad SMS variable", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "SEND_CUSTOMER_SMS", message: "Hi {{email}}" }],
    });
    await expect(publishWorkflow(workspaceId, invalidVariable.id)).rejects.toMatchObject({
      code: "WORKFLOW_TEMPLATE_VARIABLE_UNSUPPORTED",
    });

    await db.insert(user).values({
      id: "other-workspace-user",
      name: "Other",
      email: "other-workspace@example.com",
      emailVerified: true,
    });
    const [otherWorkspace] = await db.insert(workspaces).values({ name: "Other Workspace" }).returning();
    await db.insert(memberships).values({
      workspaceId: otherWorkspace.id,
      userId: "other-workspace-user",
      role: "OWNER",
    });
    const crossWorkspace = await createWorkflowDraft(workspaceId, "Cross workspace", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [{ type: "ASSIGN_LEAD", userId: "other-workspace-user" }],
    });
    await expect(publishWorkflow(workspaceId, crossWorkspace.id)).rejects.toMatchObject({
      code: "WORKFLOW_STAFF_INVALID",
    });
  });

  it("cancels queued work on pause and never replays events that occurred while paused", async () => {
    const draft = await createWorkflowDraft(workspaceId, "Pause safe", original);
    const version = await publishWorkflow(workspaceId, draft.id);
    const stored = await getWorkflowVersion(workspaceId, version.id);
    if (!stored) throw new Error("Published workflow missing");

    const [queuedEvent] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "queued-before-pause",
      payload: { qualificationScore: 90 },
    }).returning();
    const queuedRun = await createWorkflowRun({
      workspaceId,
      eventId: queuedEvent.id,
      workflowVersionId: version.id,
      actions: stored.snapshot.actions,
    });
    if (!queuedRun) throw new Error("Published workflow unexpectedly became inactive.");

    await setWorkflowStatus(workspaceId, draft.id, "PAUSED");
    const [cancelledRun] = await db.select().from(automationRuns)
      .where(eq(automationRuns.id, queuedRun.id));
    expect(cancelledRun.status).toBe("CANCELLED");
    const [cancelledAction] = await db.select().from(workflowActionRuns)
      .where(eq(workflowActionRuns.automationRunId, queuedRun.id));
    expect(cancelledAction.status).toBe("CANCELLED");

    const [pausedEvent] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "happened-while-paused",
      payload: { qualificationScore: 99 },
    }).returning();

    await setWorkflowStatus(workspaceId, draft.id, "PUBLISHED");
    // Previously active but undispatched work must not resurrect after a pause.
    expect(await listPublishedWorkflowVersions(workspaceId, queuedEvent.id)).toHaveLength(0);
    expect(await listPublishedWorkflowVersions(workspaceId, pausedEvent.id)).toHaveLength(0);

    const [futureEvent] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "after-resume",
      payload: { qualificationScore: 99 },
    }).returning();
    expect((await listPublishedWorkflowVersions(workspaceId, futureEvent.id))[0]?.id).toBe(version.id);
  });

  it("requests cancellation for an in-flight run while preserving completed actions", async () => {
    const draft = await createWorkflowDraft(workspaceId, "Pause in flight", {
      trigger: "LEAD_QUALIFIED",
      conditions: [],
      actions: [
        { type: "NOTIFY_STAFF", title: "First", message: "First action" },
        { type: "NOTIFY_STAFF", title: "Second", message: "Second action" },
      ],
    });
    const version = await publishWorkflow(workspaceId, draft.id);
    const stored = await getWorkflowVersion(workspaceId, version.id);
    if (!stored) throw new Error("Published workflow missing");
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "in-flight",
      payload: { qualificationScore: 90 },
    }).returning();
    const run = await createWorkflowRun({
      workspaceId,
      eventId: event.id,
      workflowVersionId: version.id,
      actions: stored.snapshot.actions,
    });
    if (!run) throw new Error("Published workflow unexpectedly became inactive.");
    await db.update(automationRuns).set({
      status: "RUNNING",
      startedAt: new Date(),
    }).where(eq(automationRuns.id, run.id));
    const actionRows = await db.select().from(workflowActionRuns)
      .where(eq(workflowActionRuns.automationRunId, run.id))
      .orderBy(workflowActionRuns.actionIndex);
    await db.update(workflowActionRuns).set({
      status: "COMPLETED",
      completedAt: new Date(),
    }).where(eq(workflowActionRuns.id, actionRows[0].id));

    await setWorkflowStatus(workspaceId, draft.id, "PAUSED");

    const [storedRun] = await db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(storedRun.status).toBe("RUNNING");
    expect(storedRun.cancelRequestedAt).toBeInstanceOf(Date);
    const after = await db.select().from(workflowActionRuns)
      .where(eq(workflowActionRuns.automationRunId, run.id))
      .orderBy(workflowActionRuns.actionIndex);
    expect(after.map(action => action.status)).toEqual(["COMPLETED", "CANCELLED"]);
  });

  it("publishes immutable versions, preserves the active version while editing, and does not republish duplicates", async () => {
    const draft = await createWorkflowDraft(workspaceId, "Lead review", original);
    const version1 = await publishWorkflow(workspaceId, draft.id);
    expect(version1.version).toBe(1);
    expect((await publishWorkflow(workspaceId, draft.id)).id).toBe(version1.id);
    const [priorEvent] = await db.insert(automationEvents).values({
      workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
      aggregateId: "lead-before-new-version", payload: { qualificationScore: 81 },
    }).returning();

    await updateWorkflowDraft(workspaceId, draft.id, "Lead review", {
      ...original, conditions: [{ field: "qualificationScore", operator: "GTE", value: 90 }],
      actions: [{ type: "NOTIFY_STAFF", title: "Urgent lead", message: "Review urgently." }],
    });
    expect((await listPublishedWorkflowVersions(workspaceId))[0].id).toBe(version1.id);
    const version2 = await publishWorkflow(workspaceId, draft.id);
    expect(version2.version).toBe(2);
    expect(version2.id).not.toBe(version1.id);
    expect((await listPublishedWorkflowVersions(workspaceId, priorEvent.id))[0].id).toBe(version1.id);
    const storedV1 = await getWorkflowVersion(workspaceId, version1.id);
    const storedV2 = await getWorkflowVersion(workspaceId, version2.id);
    expect(storedV1?.snapshot.actions[0]).toMatchObject({
      type: "NOTIFY_STAFF",
      title: "High-priority lead",
    });
    expect(storedV2?.snapshot.actions[0]).toMatchObject({
      type: "NOTIFY_STAFF",
      title: "Urgent lead",
    });

    await setWorkflowStatus(workspaceId, draft.id, "PAUSED");
    expect(await listPublishedWorkflowVersions(workspaceId)).toHaveLength(0);
    await setWorkflowStatus(workspaceId, draft.id, "PUBLISHED");
    expect((await listPublishedWorkflowVersions(workspaceId))[0].id).toBe(version2.id);
    await setWorkflowStatus(workspaceId, draft.id, "ARCHIVED");
    await expect(updateWorkflowDraft(workspaceId, draft.id, "Changed", original)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_EDITABLE",
    });
  });


  it("does not match events predating the first published workflow version", async () => {
    const [historical] = await db.insert(automationEvents).values({
      workspaceId, type: "LEAD_QUALIFIED", aggregateType: "LEAD",
      aggregateId: "lead-before-publication", payload: { qualificationScore: 99 },
    }).returning();
    const definition = await createWorkflowDraft(workspaceId, "New workflow", original);
    await publishWorkflow(workspaceId, definition.id);
    expect(await listPublishedWorkflowVersions(workspaceId, historical.id)).toHaveLength(0);
  });

  it("never exposes published versions from another workspace", async () => {
    const draft = await createWorkflowDraft(workspaceId, "Private", original);
    const version = await publishWorkflow(workspaceId, draft.id);
    const [other] = await db.insert(workspaces).values({ name: "Other Workspace" }).returning();
    await db.insert(memberships).values({
      workspaceId: other.id,
      userId: "workflow-owner",
      role: "OWNER",
    });
    expect(await listPublishedWorkflowVersions(other.id)).toHaveLength(0);
    expect(await getWorkflowVersion(other.id, version.id)).toBeNull();
    await expect(updateWorkflowDraft(other.id, draft.id, "Hijacked", original)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_EDITABLE",
    });
  });
});
