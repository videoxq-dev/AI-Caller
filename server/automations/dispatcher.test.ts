import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  automationEvents,
  automationRuns,
  automationSettings,
  memberships,
  user,
  workspaces,
} from "@/db/schema";
import { dispatchAutomationEvent } from "./dispatcher";

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
  });
});
