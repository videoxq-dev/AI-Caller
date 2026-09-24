import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, messages, providerWebhookEvents, usageEvents, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import type { WhatsAppInboundResponseJob } from "@/server/jobs/queues";
import type { WhatsAppProvider } from "@/server/providers/contracts";
import type { WhatsAppRuntime } from "@/server/providers/whatsapp/runtime";
import { createWhatsAppOutboundService } from "./outbound";
import { getWhatsAppConsentStatus } from "./consent";
import { createWhatsAppWebhookService } from "./service";

const APP_SECRET = "whatsapp-test-secret";
// Test the injected responder's transport failures independently of rollout.
vi.mock("@/server/booking/rollout", () => ({ shouldUseBookingV2: vi.fn(async () => false) }));

function signedRequest(body: string) {
  const signature = createHmac("sha256", APP_SECRET).update(body).digest("hex");
  return new Request("https://app.example.com/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

function inboundPayload(id = "wamid.inbound", from = "15551234567") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone-id-1" },
          contacts: [{ profile: { name: "Ada" }, wa_id: from }],
          messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "I need an appointment" } }],
        },
      }],
    }],
  });
}

function deliveryPayload(id: string, status: "sent" | "delivered" | "read" | "failed") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone-id-1" },
          statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000) + 60) }],
        },
      }],
    }],
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

function runtimeFor(workspaceId: string, provider: WhatsAppProvider): WhatsAppRuntime {
  return {
    workspaceId,
    integrationId: "22222222-2222-4222-8222-222222222222",
    phoneNumberId: "phone-id-1",
    wabaId: "waba-1",
    mode: "BYOP",
    providerName: "whatsapp",
    provider,
  };
}

function harness(
  runtime: WhatsAppRuntime,
  respond: () => Promise<ReturnType<typeof orchestratorReply>>,
  options: { resolveForWorkspace?: (workspaceId: string) => Promise<WhatsAppRuntime> } = {},
) {
  const jobs: WhatsAppInboundResponseJob[] = [];
  const outbound = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });
  const service = createWhatsAppWebhookService({
    resolveByPhoneNumberId: async () => runtime,
    resolveForWorkspace: options.resolveForWorkspace ?? (async () => runtime),
    respond: async () => respond(),
    sendText: (workspaceId, conversationId, input) => outbound.sendText(workspaceId, conversationId, input),
    enqueueResponseJob: async (job) => {
      jobs.push(job);
      return `job-${jobs.length}`;
    },
  });
  return { service, jobs };
}

describe("WhatsApp webhook service", () => {
  let workspaceId = "";

  beforeEach(async () => {
    process.env.META_APP_SECRET = APP_SECRET;
    resetEnvForTests();
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "WhatsApp Service Test" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("queues once, persists a unified WhatsApp timeline, and suppresses duplicate provider delivery", async () => {
    const sendText = vi.fn(async () => ({ externalId: "wamid.outbound", status: "SENT" as const }));
    const provider: WhatsAppProvider = {
      sendText,
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const respond = vi.fn(async () => orchestratorReply("I can help you book that."));
    const { service, jobs } = harness(runtime, respond);
    const body = inboundPayload();

    await expect(service.ingest(signedRequest(body))).resolves.toMatchObject({ queued: 1, duplicates: 0 });
    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({ replied: true });
    await expect(service.ingest(signedRequest(body))).resolves.toMatchObject({ queued: 0, duplicates: 1 });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(2);
    expect(stored.find((message) => message.direction === "INBOUND")?.metadata).toMatchObject({ whatsappWaId: "15551234567" });
    expect(stored.map((message) => [message.channel, message.direction, message.externalMessageId])).toEqual(
      expect.arrayContaining([
        ["WHATSAPP", "INBOUND", "wamid.inbound"],
        ["WHATSAPP", "OUTBOUND", "wamid.outbound"],
      ]),
    );
    const identities = await db.select().from(contactIdentities);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ channel: "WHATSAPP", normalizedValue: "+15551234567" });
    const usage = await db.select().from(usageEvents);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ capability: "WHATSAPP", provider: "whatsapp", mode: "BYOP", creditsCharged: 0 });
  });

  it("reconciles out-of-order delivery callbacks without moving a read message backward", async () => {
    const provider: WhatsAppProvider = {
      sendText: vi.fn(async () => ({ externalId: "wamid.out-2", status: "SENT" as const })),
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const { service, jobs } = harness(runtime, async () => orchestratorReply("Confirmed"));

    const inbound = inboundPayload("wamid.in-2", "15551234568");
    await service.ingest(signedRequest(inbound));
    await service.processInboundJob(jobs[0]);
    await service.ingest(signedRequest(deliveryPayload("wamid.out-2", "read")));
    await service.ingest(signedRequest(deliveryPayload("wamid.out-2", "sent")));

    const outbound = (await db.select().from(messages)).find((message) => message.direction === "OUTBOUND");
    expect(outbound?.status).toBe("READ");
  });

  it("requeues failures that happen before orchestration begins", async () => {
    const sendText = vi.fn(async () => ({ externalId: "wamid.retry-out", status: "SENT" as const }));
    const provider: WhatsAppProvider = {
      sendText,
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const respond = vi.fn(async () => orchestratorReply("Recovered"));
    let resolveAttempt = 0;
    const resolveForWorkspace = vi.fn(async () => {
      resolveAttempt += 1;
      if (resolveAttempt === 1) throw new Error("temporary runtime failure");
      return runtime;
    });
    const { service, jobs } = harness(runtime, respond, { resolveForWorkspace });

    await service.ingest(signedRequest(inboundPayload("wamid.retry", "15551234569")));
    await expect(service.processInboundJob(jobs[0])).rejects.toThrow("temporary runtime failure");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("QUEUED");
    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({ replied: true });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("PROCESSED");
  });

  it("records signed STOP/START without running AI and never restores marketing via START", async () => {
    const sendText = vi.fn(async () => ({ externalId: "wamid.no-reply", status: "SENT" as const }));
    const provider: WhatsAppProvider = {
      sendText,
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const respond = vi.fn(async () => orchestratorReply("Should not run"));
    const { service, jobs } = harness(runtimeFor(workspaceId, provider), respond);
    const stop = inboundPayload("wamid.stop", "15551234567").replace("I need an appointment", "STOP");
    await service.ingest(signedRequest(stop));
    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({
      replied: false, consentUpdated: true,
    });
    expect(await getWhatsAppConsentStatus(workspaceId, "15551234567", "UTILITY")).toBe("OPTED_OUT");
    expect(await getWhatsAppConsentStatus(workspaceId, "15551234567", "MARKETING")).toBe("OPTED_OUT");
    const start = inboundPayload("wamid.start", "15551234567").replace("I need an appointment", "START");
    await service.ingest(signedRequest(start));
    await expect(service.processInboundJob(jobs[1])).resolves.toMatchObject({
      replied: false, consentUpdated: true,
    });
    expect(await getWhatsAppConsentStatus(workspaceId, "15551234567", "UTILITY")).toBe("OPTED_IN");
    expect(await getWhatsAppConsentStatus(workspaceId, "15551234567", "MARKETING")).toBe("OPTED_OUT");
    expect(respond).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("fails closed once orchestration begins so retries cannot replay calendar/provider tools", async () => {
    const sendText = vi.fn(async () => ({ externalId: "wamid.should-not-send", status: "SENT" as const }));
    const provider: WhatsAppProvider = {
      sendText,
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const runtime = runtimeFor(workspaceId, provider);
    const respond = vi.fn(async () => { throw new Error("orchestrator failed after starting"); });
    const { service, jobs } = harness(runtime, respond);

    await service.ingest(signedRequest(inboundPayload("wamid.fail-closed", "15551234570")));
    await expect(service.processInboundJob(jobs[0])).rejects.toThrow("orchestrator failed after starting");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("FAILED");
    await expect(service.processInboundJob(jobs[0])).resolves.toEqual({ skipped: true });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });
});
