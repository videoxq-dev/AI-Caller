import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { contactIdentities, messages, providerWebhookEvents, usageEvents, workspaces } from "@/db/schema";
import { resetEnvForTests } from "@/server/env";
import type { WhatsAppInboundResponseJob } from "@/server/jobs/queues";
import type { WhatsAppProvider } from "@/server/providers/contracts";
import type { WhatsAppRuntime } from "@/server/providers/whatsapp/runtime";
import { createWhatsAppWebhookService } from "./service";

const APP_SECRET = "whatsapp-test-secret";

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
          messages: [{ id, from, timestamp: "1789675200", type: "text", text: { body: "I need an appointment" } }],
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
          statuses: [{ id, status, timestamp: "1789675260" }],
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

function harness(runtime: WhatsAppRuntime, respond: () => Promise<ReturnType<typeof orchestratorReply>>) {
  const jobs: WhatsAppInboundResponseJob[] = [];
  const service = createWhatsAppWebhookService({
    resolveByPhoneNumberId: async () => runtime,
    resolveForWorkspace: async () => runtime,
    respond: async () => respond(),
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
    expect(stored.map((message) => [message.channel, message.direction, message.externalMessageId])).toEqual([
      ["WHATSAPP", "INBOUND", "wamid.inbound"],
      ["WHATSAPP", "OUTBOUND", "wamid.outbound"],
    ]);
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

  it("requeues pre-send failures so the worker can safely retry", async () => {
    const sendText = vi.fn(async () => ({ externalId: "wamid.retry-out", status: "SENT" as const }));
    const provider: WhatsAppProvider = {
      sendText,
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    const runtime = runtimeFor(workspaceId, provider);
    let attempt = 0;
    const respond = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary orchestrator failure");
      return orchestratorReply("Recovered");
    });
    const { service, jobs } = harness(runtime, respond);

    await service.ingest(signedRequest(inboundPayload("wamid.retry", "15551234569")));
    await expect(service.processInboundJob(jobs[0])).rejects.toThrow("temporary orchestrator failure");
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("QUEUED");
    await expect(service.processInboundJob(jobs[0])).resolves.toMatchObject({ replied: true });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await db.select().from(providerWebhookEvents))[0].status).toBe("PROCESSED");
  });
});
