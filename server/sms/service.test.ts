import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, messages, workspaces } from "@/db/schema";
import type { NormalizedSmsEvent, SMSProvider } from "@/server/providers/contracts";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { createSmsWebhookService } from "./service";

function request(body = "{}") {
  return new Request("https://app.example.com/api/webhooks/sms/twilio/11111111-1111-4111-8111-111111111111", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-signature": "valid" },
    body,
  });
}

function orchestratorReply(text: string | null) {
  return {
    reply: text,
    handlingMode: text ? "AI" as const : "HUMAN" as const,
    action: { type: "NONE" as const },
    toolResult: { kind: "none" as const, data: {} },
  };
}

describe("SMS webhook service", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Service Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists one inbound/outbound pair and does not replay duplicate inbound events", async () => {
    const inbound: NormalizedSmsEvent = {
      type: "MESSAGE_RECEIVED",
      externalEventId: "evt-in-1",
      externalMessageId: "msg-in-1",
      from: "+12025550100",
      to: "+12025550200",
      text: "I need an appointment",
      occurredAt: null,
    };
    const send = vi.fn(async () => ({ externalId: "msg-out-1", status: "QUEUED" as const }));
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [inbound]),
    };
    const runtime: SmsRuntime = {
      workspaceId,
      mode: "BYOP",
      providerName: "twilio",
      integrationId: "22222222-2222-4222-8222-222222222222",
      senderNumber: "+12025550200",
      provider,
    };
    const respond = vi.fn(async () => orchestratorReply("Sure — I can help with that."));
    const service = createSmsWebhookService({ resolveRuntime: async () => runtime, respond });

    await expect(service.process(request(), workspaceId, "twilio")).resolves.toMatchObject({ processed: 1, duplicates: 0 });
    await expect(service.process(request(), workspaceId, "twilio")).resolves.toMatchObject({ processed: 0, duplicates: 1 });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(2);
    expect(stored.map((message) => [message.direction, message.body, message.externalMessageId])).toEqual([
      ["INBOUND", "I need an appointment", "msg-in-1"],
      ["OUTBOUND", "Sure — I can help with that.", "msg-out-1"],
    ]);
    const identities = await db.select().from(contactIdentities);
    expect(identities).toHaveLength(1);
    expect(identities[0].channel).toBe("SMS");
    expect(identities[0].normalizedValue).toBe("+12025550100");
  });

  it("reconciles delivery callbacks onto the existing outbound message", async () => {
    const send = vi.fn(async () => ({ externalId: "msg-out-2", status: "QUEUED" as const }));
    let normalized: NormalizedSmsEvent[] = [{
      type: "MESSAGE_RECEIVED",
      externalEventId: "evt-in-2",
      externalMessageId: "msg-in-2",
      from: "+12025550101",
      to: "+12025550200",
      text: "Hello",
      occurredAt: null,
    }];
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => normalized),
    };
    const runtime: SmsRuntime = {
      workspaceId,
      mode: "BYOP",
      providerName: "twilio",
      integrationId: "33333333-3333-4333-8333-333333333333",
      senderNumber: "+12025550200",
      provider,
    };
    const service = createSmsWebhookService({ resolveRuntime: async () => runtime, respond: async () => orchestratorReply("Hi there") });

    await service.process(request(), workspaceId, "twilio");
    normalized = [{
      type: "DELIVERY_UPDATED",
      externalEventId: "evt-delivery-2",
      externalMessageId: "msg-out-2",
      status: "DELIVERED",
      error: null,
      occurredAt: null,
    }];
    await expect(service.process(request(), workspaceId, "twilio")).resolves.toMatchObject({ processed: 1 });

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(2);
    const outbound = stored.find((message) => message.direction === "OUTBOUND");
    expect(outbound?.externalMessageId).toBe("msg-out-2");
    expect(outbound?.status).toBe("DELIVERED");
  });
});
