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

  it("allows only one queue transition and one worker claim", async () => {
    const claim = await claimProviderWebhookEvent(workspaceId, {
      provider: "twilio",
      externalEventId: "SM-queued",
      payload: {},
    });
    const payload = {
      workspaceId,
      provider: "twilio",
      webhookEventId: claim.eventId,
      externalMessageId: "SM-queued",
      customerNumber: "+12025550100",
      destinationNumber: "+12025550200",
      text: "Hello",
    };
    const transitions = await Promise.all(Array.from({ length: 8 }, () => markProviderWebhookQueued(workspaceId, claim.eventId, payload)));
    expect(transitions.filter(Boolean)).toHaveLength(1);

    const workers = await Promise.all(Array.from({ length: 8 }, () => claimQueuedProviderWebhookEvent(workspaceId, claim.eventId)));
    expect(workers.filter(Boolean)).toHaveLength(1);
    const [stored] = await db.select().from(providerWebhookEvents);
    expect(stored.status).toBe("PROCESSING");
    expect(stored.payload).toMatchObject({ externalMessageId: "SM-queued", text: "Hello" });
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

  it("deduplicates the same provider event independently per workspace", async () => {
    const first = await claimProviderWebhookEvent(workspaceId, {
      provider: "telnyx",
      externalEventId: "shared-event",
      payload: {},
    });
    const [other] = await db.insert(workspaces).values({ name: "Other Workspace" }).returning();
    const second = await claimProviderWebhookEvent(other.id, {
      provider: "telnyx",
      externalEventId: "shared-event",
      payload: {},
    });

    expect(first.state).toBe("claimed");
    expect(second.state).toBe("claimed");
    const rows = await db.select().from(providerWebhookEvents);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.workspaceId))).toEqual(new Set([workspaceId, other.id]));
  });
});
