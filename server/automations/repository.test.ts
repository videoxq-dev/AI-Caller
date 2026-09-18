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
  listRecoverableAutomationRuns,
  releaseAutomationRunForRetry,
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
