import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  automationEvents,
  automationRuns,
  automationSettings,
  memberships,
  user,
  workspaces,
} from "@/db/schema";
import {
  claimAutomationRun,
  createAutomationRun,
  listAutomationActivity,
  listRecoverableAutomationRuns,
  releaseAutomationRunForRetry,
  saveAutomationSetting,
} from "./repository";

let workspaceId = "";
let eventId = "";

describe("automation run claiming", () => {
  beforeEach(async () => {
    await db.delete(automationRuns);
    await db.delete(automationEvents);
    await db.delete(automationSettings);
    await db.delete(memberships);
    await db.delete(workspaces);
    await db.delete(user);

    await db.insert(user).values({ id: "run-owner", name: "Owner", email: "run@example.com", emailVerified: true });
    const [workspace] = await db.insert(workspaces).values({ name: "Run Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(memberships).values({ workspaceId, userId: "run-owner", role: "OWNER" });
    const [event] = await db.insert(automationEvents).values({
      workspaceId,
      type: "LEAD_QUALIFIED",
      aggregateType: "LEAD",
      aggregateId: "lead-run",
    }).returning();
    eventId = event.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("rejects a configured assignee who is not a workspace member", async () => {
    await expect(saveAutomationSetting(workspaceId, "QUALIFIED_LEAD_ASSIGNMENT", {
      enabled: true,
      config: { assignedUserId: "not-a-workspace-member", notifyInApp: true },
    })).rejects.toMatchObject({
      code: "AUTOMATION_ASSIGNEE_INVALID",
      status: 400,
    });
  });

  it("can exclude custom workflow history while retaining built-in automation activity", async () => {
    await createAutomationRun({
      workspaceId,
      eventId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
    });
    await db.insert(automationRuns).values({
      workspaceId,
      eventId,
      key: null,
      workflowVersionId: null,
      occurrenceKey: "custom-history",
      status: "COMPLETED",
      completedAt: new Date(),
    });

    const allActivity = await listAutomationActivity(workspaceId, 20);
    expect(allActivity).toHaveLength(2);

    const builtInOnly = await listAutomationActivity(workspaceId, 20, undefined, false);
    expect(builtInOnly).toHaveLength(1);
    expect(builtInOnly[0]?.run.key).toBe("QUALIFIED_LEAD_ASSIGNMENT");
  });

  it("does not claim a scheduled run before its due time", async () => {
    const run = await createAutomationRun({
      workspaceId,
      eventId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
      scheduledFor: new Date(Date.now() + 60_000),
    });
    expect(await claimAutomationRun(workspaceId, run.id)).toBeNull();
  });

  it("releases a claimed run so queue retry can claim it again", async () => {
    const run = await createAutomationRun({
      workspaceId,
      eventId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
    });
    expect((await claimAutomationRun(workspaceId, run.id))?.status).toBe("RUNNING");
    expect((await releaseAutomationRunForRetry(workspaceId, run.id))?.status).toBe("PENDING");
    expect((await claimAutomationRun(workspaceId, run.id))?.status).toBe("RUNNING");
  });

  it("reclaims a stale running run after a worker crash", async () => {
    const run = await createAutomationRun({
      workspaceId,
      eventId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
    });
    await db.update(automationRuns).set({
      status: "RUNNING",
      startedAt: new Date(Date.now() - 3 * 60_000),
    });
    expect((await claimAutomationRun(workspaceId, run.id))?.status).toBe("RUNNING");
    const recoverable = await listRecoverableAutomationRuns();
    expect(recoverable.some((item) => item.id === run.id)).toBe(false);
  });

  it("surfaces stale running runs to the worker recovery sweep", async () => {
    const run = await createAutomationRun({
      workspaceId,
      eventId,
      key: "QUALIFIED_LEAD_ASSIGNMENT",
    });
    await db.update(automationRuns).set({
      status: "RUNNING",
      startedAt: new Date(Date.now() - 3 * 60_000),
    });
    const recoverable = await listRecoverableAutomationRuns();
    expect(recoverable.some((item) => item.id === run.id)).toBe(true);
  });
});
