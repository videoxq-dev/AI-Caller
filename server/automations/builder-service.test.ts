import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import {
  automationEvents,
  automationRuns,
  memberships,
  user,
  workflowDefinitions,
  workspaces,
} from "@/db/schema";
import { builderCatalog, builderStarter } from "./builder-catalog";
import {
  getBuilderWorkflow,
  listBuilderWorkflows,
  testBuilderWorkflow,
} from "./builder-service";
import {
  createWorkflowDraft,
  publishWorkflow,
  setWorkflowStatus,
  updateWorkflowDraft,
} from "./workflows";

const ownerId = "phase4-owner";
const otherOwnerId = "phase4-other-owner";
let workspaceId = "";
let otherWorkspaceId = "";

async function clean() {
  await db.delete(automationRuns);
  await db.delete(automationEvents);
  await db.delete(workflowDefinitions);
  await db.delete(memberships);
  await db.delete(workspaces);
  await db.delete(user);
}

describe("Phase 4 automation builder service", () => {
  beforeEach(async () => {
    await clean();
    await db.insert(user).values([
      { id: ownerId, name: "Owner", email: "phase4-owner@example.com", emailVerified: true },
      { id: otherOwnerId, name: "Other", email: "phase4-other@example.com", emailVerified: true },
    ]);
    const [workspace, other] = await db.insert(workspaces).values([
      { name: "Phase 4 Builder" },
      { name: "Other Builder Workspace" },
    ]).returning();
    workspaceId = workspace.id;
    otherWorkspaceId = other.id;
    await db.insert(memberships).values([
      { workspaceId, userId: ownerId, role: "OWNER" },
      { workspaceId: otherWorkspaceId, userId: otherOwnerId, role: "OWNER" },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("exposes only business-facing builder conditions and hides appointment revision", () => {
    expect(builderCatalog.triggers.map(item => item.label)).toContain("Lead becomes qualified");
    expect(builderCatalog.triggers.flatMap(item => item.conditions)).not.toContain("revision");
    expect(builderCatalog.conditions.qualificationScore.operators).toEqual([
      { id: "EQ", label: "is" },
      { id: "GTE", label: "is at least" },
      { id: "LTE", label: "is at most" },
    ]);
  });

  it("lists workspace automations without exposing workflow versions", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    const items = await listBuilderWorkflows(workspaceId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: created.id,
      name: "High-value lead alert",
      status: "DRAFT",
      triggerLabel: "Lead becomes qualified",
      actionLabels: ["Notify"],
      runCount: 0,
      hasUnpublishedChanges: false,
    });
    expect(items[0]).not.toHaveProperty("publishedVersion");
    expect(items[0]).not.toHaveProperty("version");
  });

  it("dry-runs qualification conditions without creating events or runs", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);

    await expect(testBuilderWorkflow(workspaceId, created.id, {
      sample: { qualificationScore: 90 },
    })).resolves.toMatchObject({
      matches: true,
      conditions: [{
        field: "Qualification score",
        operator: "is at least",
        actual: 90,
        expected: 80,
        matched: true,
      }],
      actions: [{ type: "NOTIFY_STAFF", label: "Notify" }],
    });

    await expect(testBuilderWorkflow(workspaceId, created.id, {
      sample: { qualificationScore: 60 },
    })).resolves.toMatchObject({
      matches: false,
      conditions: [{ matched: false }],
    });

    const unsavedDraft = {
      ...starter.definition,
      conditions: [{ field: "qualificationScore" as const, operator: "GTE" as const, value: 95 }],
    };
    await expect(testBuilderWorkflow(workspaceId, created.id, {
      draft: unsavedDraft,
      sample: { qualificationScore: 92 },
    })).resolves.toMatchObject({ matches: false });
    const persisted = await getBuilderWorkflow(workspaceId, created.id);
    expect(persisted.draft.conditions[0]).toMatchObject({ value: 80 });

    expect(await db.select().from(automationEvents)).toHaveLength(0);
    expect(await db.select().from(automationRuns)).toHaveLength(0);
  });

  it("requires sample values only for conditions the draft actually uses", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);

    await expect(testBuilderWorkflow(workspaceId, created.id, { sample: {} })).rejects.toMatchObject({
      code: "WORKFLOW_TEST_INPUT_REQUIRED",
    });

    const appointment = builderStarter("NEW_APPOINTMENT_ALERT");
    const appointmentDraft = await createWorkflowDraft(
      workspaceId,
      appointment.name,
      appointment.definition,
    );
    await expect(testBuilderWorkflow(workspaceId, appointmentDraft.id, { sample: {} })).resolves.toMatchObject({
      matches: true,
    });
  });

  it("dry-run rejects actions targeting someone outside the workspace", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    await expect(testBuilderWorkflow(workspaceId, created.id, {
      draft: {
        trigger: "LEAD_QUALIFIED",
        match: "ALL",
        conditions: [],
        actions: [{ type: "ASSIGN_LEAD", userId: otherOwnerId }],
      },
      sample: {},
    })).rejects.toMatchObject({ code: "WORKFLOW_STAFF_INVALID" });
  });

  it("reports unpublished changes while the active automation remains active", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    await publishWorkflow(workspaceId, created.id);

    expect(await getBuilderWorkflow(workspaceId, created.id)).toMatchObject({
      status: "ACTIVE",
      hasUnpublishedChanges: false,
    });

    await updateWorkflowDraft(workspaceId, created.id, "Priority lead alert", {
      ...starter.definition,
      conditions: [{ field: "qualificationScore", operator: "GTE", value: 90 }],
    });

    expect(await getBuilderWorkflow(workspaceId, created.id)).toMatchObject({
      name: "Priority lead alert",
      status: "ACTIVE",
      hasUnpublishedChanges: true,
    });
  });

  it("maps published pause and resume to simple builder statuses", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    await publishWorkflow(workspaceId, created.id);
    await setWorkflowStatus(workspaceId, created.id, "PAUSED");
    expect((await getBuilderWorkflow(workspaceId, created.id)).status).toBe("PAUSED");
    await setWorkflowStatus(workspaceId, created.id, "PUBLISHED");
    expect((await getBuilderWorkflow(workspaceId, created.id)).status).toBe("ACTIVE");
  });

  it("archives draft automations without exposing them in the builder list", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    await setWorkflowStatus(workspaceId, created.id, "ARCHIVED");

    expect(await listBuilderWorkflows(workspaceId)).toHaveLength(0);
    await expect(getBuilderWorkflow(workspaceId, created.id)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
  });

  it("never returns another workspace's automation", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(otherWorkspaceId, starter.name, starter.definition);

    await expect(getBuilderWorkflow(workspaceId, created.id)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
    expect(await listBuilderWorkflows(workspaceId)).toHaveLength(0);
  });

  it("keeps list results scoped after updates", async () => {
    const starter = builderStarter("HIGH_VALUE_LEAD_ALERT");
    const created = await createWorkflowDraft(workspaceId, starter.name, starter.definition);
    await updateWorkflowDraft(workspaceId, created.id, "Updated automation", starter.definition);
    const [row] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, created.id));
    expect(row.name).toBe("Updated automation");
    expect((await listBuilderWorkflows(workspaceId))[0].name).toBe("Updated automation");
  });
});
