import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { providerWebhookEvents, workspaces } from "@/db/schema";
import type { NormalizedSmsEvent, SMSProvider } from "@/server/providers/contracts";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { createSmsWebhookService } from "./service";

describe("SMS webhook workspace routing", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Routing Security Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("rejects a signed inbound event for the wrong destination before claiming it", async () => {
    const event: NormalizedSmsEvent = {
      type: "MESSAGE_RECEIVED",
      externalEventId: "evt-cross-workspace",
      externalMessageId: "msg-cross-workspace",
      from: "+12025550100",
      to: "+12025550999",
      text: "Hello",
      occurredAt: null,
    };
    const provider: SMSProvider = {
      send: vi.fn(async () => ({ externalId: "unused", status: "QUEUED" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [event]),
    };
    const runtime: SmsRuntime = {
      workspaceId,
      mode: "HOSTED",
      providerName: "telnyx",
      integrationId: null,
      senderNumber: "+12025550200",
      serviceStatus: "ACTIVE",
      messagingReadiness: "READY",
      provider,
    };
    const enqueueResponseJob = vi.fn(async () => "unused-job");
    const respond = vi.fn(async () => ({
      reply: "unused",
      handlingMode: "AI" as const,
      action: { type: "NONE" as const },
      toolResult: { kind: "none" as const, data: {} },
    }));
    const service = createSmsWebhookService({
      resolveRuntime: async () => runtime,
      respond,
      enqueueResponseJob,
    });
    const request = new Request(`https://app.example.com/api/webhooks/sms/telnyx/${workspaceId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    await expect(service.ingest(request, workspaceId, "telnyx")).rejects.toMatchObject({
      code: "SMS_DESTINATION_MISMATCH",
      status: 409,
    });
    expect(enqueueResponseJob).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(await db.select().from(providerWebhookEvents)).toHaveLength(0);
  });
});
