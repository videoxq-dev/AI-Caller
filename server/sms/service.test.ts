import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, creditWallets, hostedApiRateCards, messages, providerWebhookEvents, usageEvents, workspaces } from "@/db/schema";
import type { SmsInboundResponseJob } from "@/server/jobs/queues";
import type { NormalizedSmsEvent, SMSProvider } from "@/server/providers/contracts";
import { ProviderRequestError } from "@/server/providers/http";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { createSmsWebhookService } from "./service";

function request(body = "{}") {
  return new Request("https://app.example.com/api/webhooks/sms/twilio/11111111-1111-4111-8111-111111111111", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-signature": "valid" },
    body,
  });
}

function orchestratorReply(text: string) {
  return {
    reply: text,
    handlingMode: "AI" as const,
    action: { type: "NONE" as const },
    toolResult: { kind: "none" as const, data: {} },
  };
}

function inboundEvent(id: string, from = "+12025550100"): NormalizedSmsEvent {
  return {
    type: "MESSAGE_RECEIVED",
    externalEventId: `evt-${id}`,
    externalMessageId: `msg-${id}`,
    from,
    to: "+12025550200",
    text: "I need an appointment",
    occurredAt: null,
  };
}

function runtimeFor(workspaceId: string, provider: SMSProvider, mode: "HOSTED" | "BYOP" = "BYOP"): SmsRuntime {
  return {
    workspaceId,
    mode,
    providerName: "twilio",
    integrationId: mode === "BYOP" ? "22222222-2222-4222-8222-222222222222" : null,
    senderNumber: "+12025550200",
    provider,
  };
}

function serviceHarness(runtime: SmsRuntime, respond: () => Promise<ReturnType<typeof orchestratorReply>>) {
  const jobs: SmsInboundResponseJob[] = [];
  const service = createSmsWebhookService({
    resolveRuntime: async () => runtime,
    respond: async () => respond(),
    enqueueResponseJob: async (job) => {
      jobs.push(job);
      return `job-${jobs.length}`;
    },
  });
  return { service, jobs };
}

describe("SMS webhook service", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "SMS Service Test" }).returning();
    workspaceId = workspace.id;
    await db.insert(hostedApiRateCards).values({
      capability: "SMS",
      provider: "twilio",
      model: "",
      unit: "SMS_SEGMENT",
      costMicros: 450,
      unitsPerCost: 1,
      targetMarginBps: 5500,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      metadata: { fixture: "sms-service-test" },
    }).onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("queues once, persists one inbound/outbound pair, and does not replay duplicate inbound events", async () => {
    const inbound = inboundEvent("in-1");
    const send = vi.fn(async () => ({ externalId: "msg-out-1", status: "QUEUED" as const }));
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [inbound]),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const respond = vi.fn(async () => orchestratorReply("Sure — I can help with that."));
    const { service, jobs } = serviceHarness(runtime, respond);

    await expect(service.ingest(request(), workspaceId, "twilio")).resolves.toMatchObject({ queued: 1, duplicates: 0 });
    expect(jobs).toHaveLength(1);
    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({ replied: true });
    await expect(service.ingest(request(), workspaceId, "twilio")).resolves.toMatchObject({ queued: 0, duplicates: 1 });

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

  it("requeues safe worker failures so pg-boss retries can process the SMS", async () => {
    const send = vi.fn(async () => ({ externalId: "msg-out-retry", status: "QUEUED" as const }));
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [inboundEvent("worker-retry", "+12025550104")]),
    };
    const runtime = runtimeFor(workspaceId, provider);
    let attempt = 0;
    const respond = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary orchestrator failure");
      return orchestratorReply("Recovered");
    });
    const { service, jobs } = serviceHarness(runtime, respond);

    await service.ingest(request(), workspaceId, "twilio");
    await expect(service.processInboundJob(jobs[0])).rejects.toThrow("temporary orchestrator failure");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("QUEUED");

    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({ replied: true });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.select().from(messages)).toHaveLength(2);
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("PROCESSED");
  });

  it("reconciles delivery callbacks onto the existing outbound message", async () => {
    const send = vi.fn(async () => ({ externalId: "msg-out-2", status: "QUEUED" as const }));
    let normalized: NormalizedSmsEvent[] = [inboundEvent("in-2", "+12025550101")];
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => normalized),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const { service, jobs } = serviceHarness(runtime, async () => orchestratorReply("Hi there"));

    await service.ingest(request(), workspaceId, "twilio");
    await service.processInboundJob(jobs[0]);
    normalized = [{
      type: "DELIVERY_UPDATED",
      externalEventId: "evt-delivery-2",
      externalMessageId: "msg-out-2",
      status: "DELIVERED",
      error: null,
      occurredAt: null,
    }];
    await expect(service.ingest(request(), workspaceId, "twilio")).resolves.toMatchObject({ processed: 1 });

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(2);
    const outbound = stored.find((message) => message.direction === "OUTBOUND");
    expect(outbound?.externalMessageId).toBe("msg-out-2");
    expect(outbound?.status).toBe("DELIVERED");
  });

  it("charges hosted credits once after a successful worker send", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 5 });
    const provider: SMSProvider = {
      send: vi.fn(async () => ({ externalId: "hosted-out-1", status: "QUEUED" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [inboundEvent("hosted-success")]),
    };
    const runtime = runtimeFor(workspaceId, provider, "HOSTED");
    const { service, jobs } = serviceHarness(runtime, async () => orchestratorReply("Booked"));

    await service.ingest(request(), workspaceId, "twilio");
    await service.processInboundJob(jobs[0]);
    const [wallet] = await db.select().from(creditWallets);
    expect(wallet.balance).toBe(4);
    const usage = await db.select().from(usageEvents);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ capability: "SMS", mode: "HOSTED", creditsCharged: 1, provider: "twilio" });
  });

  it("refunds hosted credits on definitive rejection but not on an uncertain provider outcome", async () => {
    await db.insert(creditWallets).values({ workspaceId, balance: 5 });
    let currentEvent = inboundEvent("hosted-reject", "+12025550102");
    const send = vi.fn(async () => { throw new ProviderRequestError("Rejected", 400); });
    const provider: SMSProvider = {
      send,
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => [currentEvent]),
    };
    const runtime = runtimeFor(workspaceId, provider, "HOSTED");
    const { service, jobs } = serviceHarness(runtime, async () => orchestratorReply("Reply"));

    await service.ingest(request(), workspaceId, "twilio");
    await expect(service.processInboundJob(jobs.shift()!)).rejects.toThrow("Rejected");
    expect((await db.select().from(creditWallets))[0].balance).toBe(5);
    expect((await db.select().from(messages)).find((message) => message.direction === "OUTBOUND")?.status).toBe("FAILED");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("FAILED");

    currentEvent = inboundEvent("hosted-unknown", "+12025550103");
    send.mockImplementation(async () => { throw new ProviderRequestError("Timeout", 504); });
    await service.ingest(request(), workspaceId, "twilio");
    await expect(service.processInboundJob(jobs.shift()!)).rejects.toThrow("Timeout");
    expect((await db.select().from(creditWallets))[0].balance).toBe(4);
    const outbound = (await db.select().from(messages)).filter((message) => message.direction === "OUTBOUND");
    expect(outbound.at(-1)?.status).toBe("SEND_UNKNOWN");
    const usage = await db.select().from(usageEvents);
    expect(usage.at(-1)).toMatchObject({ mode: "HOSTED", creditsCharged: 1 });
    expect((await db.select().from(providerWebhookEvents)).at(-1)?.status).toBe("FAILED");
  });
});
