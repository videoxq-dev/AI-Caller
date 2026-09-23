import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { automationEvents, automationRuns, memberships, user, workflowDefinitions, workflowVersions, workspaces } from "@/db/schema";
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
    expect((await getWorkflowVersion(workspaceId, version1.id))?.snapshot.actions[0].title).toBe("High-priority lead");
    expect((await getWorkflowVersion(workspaceId, version2.id))?.snapshot.actions[0].title).toBe("Urgent lead");

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
    expect(await listPublishedWorkflowVersions(other.id)).toHaveLength(0);
    expect(await getWorkflowVersion(other.id, version.id)).toBeNull();
    await expect(updateWorkflowDraft(other.id, draft.id, "Hijacked", original)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_EDITABLE",
    });
  });
});
