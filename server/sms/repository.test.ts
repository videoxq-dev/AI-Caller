import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/db";
import { providerWebhookEvents, workspaces } from "@/db/schema";
import {
  claimProviderWebhookEvent,
  claimQueuedProviderWebhookEvent,
  completeProviderWebhookEvent,
  failProviderWebhookEvent,
  markProviderWebhookQueued,
} from "./repository";

describe("provider webhook persistence", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Webhook Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("allows only one concurrent claim for the same provider event", async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () => claimProviderWebhookEvent(workspaceId, {
      provider: "telnyx",
      externalEventId: "event-123",
      payload: { data: { id: "event-123" } },
    })));

    expect(attempts.filter((attempt) => attempt.state === "claimed")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.state === "duplicate")).toHaveLength(7);

    const rows = await db.select().from(providerWebhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("RECEIVED");
  });

  it("allows only one worker to claim a queued event", async () => {
    const claim = await claimProviderWebhookEvent(workspaceId, {
      provider: "twilio",
      externalEventId: "SM-queued",
      payload: {},
    });
    await markProviderWebhookQueued(workspaceId, claim.eventId);
    const workers = await Promise.all(Array.from({ length: 8 }, () => claimQueuedProviderWebhookEvent(workspaceId, claim.eventId)));
    expect(workers.filter(Boolean)).toHaveLength(1);
    const [stored] = await db.select().from(providerWebhookEvents);
    expect(stored.status).toBe("PROCESSING");
  });

  it("records terminal processed and failed states", async () => {
    const processedClaim = await claimProviderWebhookEvent(workspaceId, {
      provider: "twilio",
      externalEventId: "SM-processed",
      payload: { MessageSid: "SM-processed" },
    });
    expect(processedClaim.state).toBe("claimed");
    const processed = await completeProviderWebhookEvent(workspaceId, processedClaim.eventId);
    expect(processed.status).toBe("PROCESSED");
    expect(processed.processedAt).toBeInstanceOf(Date);

    const failedClaim = await claimProviderWebhookEvent(workspaceId, {
      provider: "plivo",
      externalEventId: "plivo-failed",
      payload: { MessageUUID: "plivo-failed" },
    });
    expect(failedClaim.state).toBe("claimed");
    const failed = await failProviderWebhookEvent(workspaceId, failedClaim.eventId, new Error("provider payload invalid"));
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBe("provider payload invalid");
  });

  it("rejects an event id collision across workspaces", async () => {
    await claimProviderWebhookEvent(workspaceId, {
      provider: "telnyx",
      externalEventId: "shared-event",
      payload: {},
    });
    const [other] = await db.insert(workspaces).values({ name: "Other Workspace" }).returning();

    await expect(claimProviderWebhookEvent(other.id, {
      provider: "telnyx",
      externalEventId: "shared-event",
      payload: {},
    })).rejects.toMatchObject({ code: "WEBHOOK_WORKSPACE_MISMATCH", status: 409 });
  });
});
