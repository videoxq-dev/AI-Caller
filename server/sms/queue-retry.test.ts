import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { providerWebhookEvents, workspaces } from "@/db/schema";
import type { SMSProvider } from "@/server/providers/contracts";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { createSmsWebhookService } from "./service";

function inboundRequest() {
  return new Request("https://app.example.com/api/webhooks/sms/twilio/11111111-1111-4111-8111-111111111111", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("SMS queue retry behavior", () => {
  let workspaceId = "";
  let runtime: SmsRuntime;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Queue Retry Test" }).returning();
    workspaceId = workspace.id;
    const provider: SMSProvider = {
      send: vi.fn(async () => ({ externalId: "unused", status: "QUEUED" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [{
        type: "MESSAGE_RECEIVED" as const,
        externalEventId: "SM-queue-retry:received",
        externalMessageId: "SM-queue-retry",
        from: "+12025550100",
        to: "+12025550200",
        text: "Hello",
        occurredAt: null,
      }]),
    };
    runtime = {
      workspaceId,
      mode: "BYOP",
      providerName: "twilio",
      integrationId: "22222222-2222-4222-8222-222222222222",
      senderNumber: "+12025550200",
      provider,
    };
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("leaves a failed enqueue in QUEUED so a provider retry can enqueue it again", async () => {
    const failing = createSmsWebhookService({
      resolveRuntime: async () => runtime,
      respond: async () => ({ reply: null, handlingMode: "HUMAN" as const, action: { type: "NONE" as const }, toolResult: { kind: "none" as const, data: {} } }),
      enqueueResponseJob: async () => { throw new Error("queue unavailable"); },
    });

    await expect(failing.ingest(inboundRequest(), workspaceId, "twilio")).rejects.toThrow("queue unavailable");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("QUEUED");

    const enqueue = vi.fn(async () => "job-1");
    const retrying = createSmsWebhookService({
      resolveRuntime: async () => runtime,
      respond: async () => ({ reply: null, handlingMode: "HUMAN" as const, action: { type: "NONE" as const }, toolResult: { kind: "none" as const, data: {} } }),
      enqueueResponseJob: enqueue,
    });
    await expect(retrying.ingest(inboundRequest(), workspaceId, "twilio")).resolves.toMatchObject({ duplicates: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("QUEUED");
  });
});
