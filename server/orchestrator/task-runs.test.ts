import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import {
  agentTaskRuns,
  agentTaskSteps,
  contacts,
  workspaces,
} from "@/db/schema";
import {
  appendMessage,
  getOrCreateOpenConversation,
} from "@/server/domain/core/repository";
import type { OrchestratorEnvelope, OrchestratorToolResult } from "./tools";
import { createTrackedActionExecutor } from "./task-runs";

describe("agent task execution persistence", () => {
  let workspaceId: string;
  let contactId: string;
  let conversationId: string;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Task runner" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({
      workspaceId,
      name: "Customer",
    }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    await appendMessage(workspaceId, conversationId, {
      channel: "WEBCHAT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Please qualify me.",
      provider: null,
      externalMessageId: null,
      status: "RECEIVED",
      metadata: {},
    });
  });

  afterAll(closeDatabase);

  it("persists a validated action step and authoritative result", async () => {
    const result: OrchestratorToolResult = {
      kind: "qualification",
      data: { qualified: true, score: 100, missingRequired: [] },
    };
    const executor = vi.fn(async () => result);
    const tracked = createTrackedActionExecutor(executor);
    const envelope: OrchestratorEnvelope = {
      action: {
        type: "QUALIFY_LEAD",
        answers: [{ criterionId: "budget", answer: "Yes" }],
      },
    };

    expect(await tracked(workspaceId, conversationId, contactId, envelope)).toEqual(result);

    const runs = await db.select().from(agentTaskRuns);
    const steps = await db.select().from(agentTaskSteps);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workspaceId,
      conversationId,
      contactId,
      status: "COMPLETED",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      runId: runs[0].id,
      sequence: 1,
      action: "QUALIFY_LEAD",
      risk: "MUTATING",
      status: "COMPLETED",
    });
    expect(steps[0].result).toEqual({ kind: result.kind, data: result.data });
  });

  it("returns a persisted authoritative result instead of repeating the same action", async () => {
    const result: OrchestratorToolResult = {
      kind: "qualification",
      data: { qualified: true, score: 100, missingRequired: [] },
    };
    const executor = vi.fn(async () => result);
    const tracked = createTrackedActionExecutor(executor);
    const envelope: OrchestratorEnvelope = {
      action: {
        type: "QUALIFY_LEAD",
        answers: [{ criterionId: "budget", answer: "Yes" }],
      },
    };

    expect(await tracked(workspaceId, conversationId, contactId, envelope)).toEqual(result);
    expect(await tracked(workspaceId, conversationId, contactId, envelope)).toEqual(result);

    expect(executor).toHaveBeenCalledOnce();
    const runs = await db.select().from(agentTaskRuns);
    const steps = await db.select().from(agentTaskSteps);
    expect(runs).toHaveLength(1);
    expect(runs[0].taskKey).toMatch(/^turn:/);
    expect(steps).toHaveLength(1);
    expect(steps[0].idempotencyKey).toContain("orchestrator:QUALIFY_LEAD:");
  });

  it("keeps a task waiting when a consequential action requires confirmation", async () => {
    const result: OrchestratorToolResult = {
      kind: "pending_action",
      data: { pendingActionId: "pending-1", type: "SEND_SMS" },
    };
    const tracked = createTrackedActionExecutor(vi.fn(async () => result));
    const envelope: OrchestratorEnvelope = {
      action: { type: "SEND_SMS", text: "Your requested link" },
    };

    await tracked(workspaceId, conversationId, contactId, envelope);

    const [run] = await db.select().from(agentTaskRuns);
    const [step] = await db.select().from(agentTaskSteps);
    expect(run.status).toBe("WAITING_CONFIRMATION");
    expect(run.completedAt).toBeNull();
    expect(step).toMatchObject({
      action: "SEND_SMS",
      risk: "CONSEQUENTIAL",
      status: "COMPLETED",
    });
  });

  it("records failed actions without hiding the original error", async () => {
    const executor = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const tracked = createTrackedActionExecutor(executor);
    const envelope: OrchestratorEnvelope = {
      action: { type: "ESCALATE", reason: "Needs staff" },
    };

    await expect(tracked(workspaceId, conversationId, contactId, envelope))
      .rejects.toThrow("provider exploded");

    const [run] = await db.select().from(agentTaskRuns);
    const [step] = await db.select().from(agentTaskSteps);
    expect(run).toMatchObject({
      status: "FAILED",
      terminationReason: "UNEXPECTED_ACTION_FAILURE",
    });
    expect(step).toMatchObject({
      action: "ESCALATE",
      status: "FAILED",
      errorCode: "UNEXPECTED_ACTION_FAILURE",
    });
  });

  it("does not place the proven booking path behind the new task persistence dependency", async () => {
    const result: OrchestratorToolResult = {
      kind: "booking",
      data: { appointmentId: "appointment-1", status: "CONFIRMED" },
    };
    const executor = vi.fn(async () => result);
    const tracked = createTrackedActionExecutor(executor);
    const envelope: OrchestratorEnvelope = {
      action: {
        type: "BOOK_APPOINTMENT",
        startsAt: "2037-09-23T10:00:00Z",
        endsAt: "2037-09-23T11:00:00Z",
        timezone: "UTC",
        title: "Office Cleaning",
      },
    };

    expect(await tracked(workspaceId, conversationId, contactId, envelope)).toEqual(result);
    expect(await db.select().from(agentTaskRuns)).toHaveLength(0);
    expect(await db.select().from(agentTaskSteps)).toHaveLength(0);
  });
});
