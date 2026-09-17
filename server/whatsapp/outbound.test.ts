import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { messages, workspaces } from "@/db/schema";
import {
  getOrCreateContactByIdentity,
  getOrCreateOpenConversation,
  setConversationHandlingMode,
} from "@/server/domain/core/repository";
import type { WhatsAppProvider } from "@/server/providers/contracts";
import type { WhatsAppRuntime } from "@/server/providers/whatsapp/runtime";
import { createWhatsAppOutboundService } from "./outbound";

describe("WhatsApp outbound service", () => {
  let workspaceId = "";
  let conversationId = "";
  let provider: WhatsAppProvider;
  let runtime: WhatsAppRuntime;

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "WhatsApp Outbound Test" }).returning();
    workspaceId = workspace.id;
    const contact = await getOrCreateContactByIdentity(workspaceId, {
      channel: "WHATSAPP",
      externalId: "15551230000",
      name: "Ada",
    });
    const conversation = await getOrCreateOpenConversation(workspaceId, contact.id);
    conversationId = conversation.id;
    provider = {
      sendText: vi.fn(async () => ({ externalId: "wamid.staff", status: "SENT" as const })),
      sendTemplate: vi.fn(async () => ({ externalId: "wamid.template", status: "SENT" as const })),
      verifyWebhook: vi.fn(async () => true),
      normalizeWebhook: vi.fn(async () => []),
    };
    runtime = {
      workspaceId,
      integrationId: "22222222-2222-4222-8222-222222222222",
      phoneNumberId: "phone-id-1",
      wabaId: "waba-1",
      mode: "BYOP",
      providerName: "whatsapp",
      provider,
    };
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function addInbound(options: { createdAt?: Date; occurredAt?: Date; id?: string } = {}) {
    const createdAt = options.createdAt ?? new Date();
    const occurredAt = options.occurredAt ?? createdAt;
    await db.insert(messages).values({
      workspaceId,
      conversationId,
      channel: "WHATSAPP",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Hello",
      provider: "whatsapp",
      externalMessageId: options.id ?? `wamid.in.${createdAt.getTime()}.${occurredAt.getTime()}`,
      status: "RECEIVED",
      metadata: { occurredAt: occurredAt.toISOString() },
      createdAt,
    });
  }

  it("requires human takeover before a staff free-form reply", async () => {
    await addInbound();
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });
    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Hi" }))
      .rejects.toMatchObject({ code: "HUMAN_TAKEOVER_REQUIRED" });
    expect(provider.sendText).not.toHaveBeenCalled();
  });

  it("sends a staff reply during the customer window after takeover", async () => {
    await addInbound();
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });
    const sent = await service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Happy to help." });
    expect(sent).toMatchObject({ senderType: "USER", channel: "WHATSAPP", status: "SENT", externalMessageId: "wamid.staff" });
    expect(provider.sendText).toHaveBeenCalledTimes(1);
  });

  it("uses the provider event timestamp for the 24-hour customer window", async () => {
    await addInbound({ createdAt: new Date(), occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Checking in" }))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });
    expect(provider.sendText).not.toHaveBeenCalled();
  });

  it("keeps the customer window open when an older provider event is persisted after a newer one", async () => {
    const now = new Date();
    await addInbound({ createdAt: new Date(now.getTime() - 60_000), occurredAt: new Date(now.getTime() - 5 * 60_000), id: "wamid.newer-provider-event" });
    await addInbound({ createdAt: now, occurredAt: new Date(now.getTime() - 25 * 60 * 60 * 1000), id: "wamid.delayed-old-event" });
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Still in window" }))
      .resolves.toMatchObject({ status: "SENT" });
    expect(provider.sendText).toHaveBeenCalledTimes(1);
  });

  it("blocks free-form text outside 24 hours but allows an approved template path", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await addInbound({ createdAt: old, occurredAt: old });
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Checking in" }))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });
    expect(provider.sendText).not.toHaveBeenCalled();

    const sent = await service.sendTemplate(workspaceId, conversationId, {
      senderType: "USER",
      templateName: "appointment_reminder",
      languageCode: "en_US",
    });
    expect(sent).toMatchObject({ status: "SENT", externalMessageId: "wamid.template" });
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
