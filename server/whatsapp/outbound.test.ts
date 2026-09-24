import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { eq } from "drizzle-orm";
import { AppError } from "@/server/http/errors";
import { conversations, messages, providerWebhookEvents, workspaces } from "@/db/schema";
import {
  getOrCreateContactByIdentity,
  getOrCreateOpenConversation,
  setConversationHandlingMode,
} from "@/server/domain/core/repository";
import type { WhatsAppProvider } from "@/server/providers/contracts";
import type { WhatsAppRuntime } from "@/server/providers/whatsapp/runtime";
import { createWhatsAppOutboundService } from "./outbound";
import { recordWhatsAppConsent } from "./consent";

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

  async function addInbound(options: { createdAt?: Date; occurredAt?: Date | null; id?: string } = {}) {
    const createdAt = options.createdAt ?? new Date();
    const occurredAt = options.occurredAt === undefined ? createdAt : options.occurredAt;
    await db.insert(messages).values({
      workspaceId,
      conversationId,
      channel: "WHATSAPP",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentType: "TEXT",
      body: "Hello",
      provider: "whatsapp",
      externalMessageId: options.id ?? `wamid.in.${createdAt.getTime()}.${occurredAt?.getTime() ?? "missing"}`,
      status: "RECEIVED",
      metadata: occurredAt ? { occurredAt: occurredAt.toISOString() } : {},
      createdAt,
    });
  }

  it("requires WhatsApp marketing consent for an explicit free-form offer within the service window", async () => {
    await addInbound();
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });
    await expect(service.sendText(workspaceId, conversationId, {
      senderType: "AI", text: "Special offer: 20% off today.",
    })).rejects.toMatchObject({ code: "WHATSAPP_CONSENT_REQUIRED" });
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "MARKETING", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer explicitly requested WhatsApp promotions.",
    });
    const message = await service.sendText(workspaceId, conversationId, {
      senderType: "AI", text: "Special offer: 20% off today.",
    });
    expect(message.metadata.whatsappCategory).toBe("MARKETING");
    expect(provider.sendText).toHaveBeenCalledOnce();
  });

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
    expect(sent).toMatchObject({
      senderType: "USER",
      channel: "WHATSAPP",
      status: "SENT",
      externalMessageId: "wamid.staff",
      metadata: { mode: "BYOP", provider: "meta" },
    });
    expect(provider.sendText).toHaveBeenCalledTimes(1);
  });

  it("reconciles a delivery callback that arrived before the provider send response was attached", async () => {
    await addInbound();
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const occurredAt = new Date();
    await db.insert(providerWebhookEvents).values({
      workspaceId,
      provider: "whatsapp",
      externalEventId: "wamid.staff:delivered:early",
      status: "RECEIVED",
      payload: {
        type: "DELIVERY_UPDATED",
        externalMessageId: "wamid.staff",
        phoneNumberId: "phone-id-1",
        status: "DELIVERED",
        error: null,
        occurredAt: occurredAt.toISOString(),
      },
    });

    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });
    await service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Early status" });

    const outbound = (await db.select().from(messages)).find((message) => message.body === "Early status");
    expect(outbound).toMatchObject({ externalMessageId: "wamid.staff", status: "DELIVERED" });
    const [webhook] = await db.select().from(providerWebhookEvents);
    expect(webhook.status).toBe("PROCESSED");
  });

  it("uses the provider event timestamp for the 24-hour customer window", async () => {
    await addInbound({ createdAt: new Date(), occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Checking in" }))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });
    expect(provider.sendText).not.toHaveBeenCalled();
  });

  it("fails closed when provider time is missing or implausibly far in the future", async () => {
    await addInbound({ occurredAt: null, id: "wamid.missing-provider-time" });
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({ resolveRuntime: async () => runtime });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Missing timestamp" }))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });

    await addInbound({ occurredAt: new Date(Date.now() + 10 * 60 * 1000), id: "wamid.future-provider-time" });
    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Future timestamp" }))
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
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => ({
        name: "appointment_reminder", language: "en_US",
        category: "UTILITY", status: "APPROVED", body: "See you soon.",
      }),
    });

    await expect(service.sendText(workspaceId, conversationId, { senderType: "USER", text: "Checking in" }))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });
    expect(provider.sendText).not.toHaveBeenCalled();
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "UTILITY", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer agreed to appointment updates on WhatsApp.",
    });
    const sent = await service.sendTemplate(workspaceId, conversationId, {
      senderType: "USER",
      templateName: "appointment_reminder",
      languageCode: "en_US",
    });
    expect(sent).toMatchObject({
      status: "SENT",
      externalMessageId: "wamid.template",
      metadata: { mode: "BYOP", templateName: "appointment_reminder", languageCode: "en_US", provider: "meta" },
    });
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
  });
  it("rejects pending templates before storing a message or calling the provider", async () => {
    await setConversationHandlingMode(workspaceId, conversationId, "HUMAN", null);
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => ({
        name: "appointment_reminder", language: "en_US",
        category: "UTILITY", status: "PENDING", body: "See you soon.",
      }),
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "USER", templateName: "appointment_reminder", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("does not mistake a disconnected WhatsApp integration for uncertain delivery", async () => {
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => { throw new Error("Disconnected"); },
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "appointment_reminder", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_NOT_CONNECTED" });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("treats unavailable Meta approval reads as a definite never-sent suppression", async () => {
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => { throw new Error("Meta catalog is offline"); },
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "appointment_reminder", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_APPROVAL_UNVERIFIED" });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("requires distinct marketing opt-in and prevents a category swap", async () => {
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "UTILITY", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer agreed to appointment updates.",
    });
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => ({
        name: "special_offer", language: "en_US",
        category: "MARKETING", status: "APPROVED", body: "Offer.",
      }),
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "special_offer", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_CONSENT_REQUIRED" });
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "MARKETING", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer requested marketing updates on WhatsApp.",
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "special_offer", languageCode: "en_US",
      expectedCategory: "UTILITY",
    })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "special_offer", languageCode: "en_US",
      expectedCategory: "MARKETING",
    })).resolves.toMatchObject({ status: "SENT" });
    expect(provider.sendTemplate).toHaveBeenCalledOnce();
  });

  it("records a late Meta approval outage as suppressed without provider ambiguity", async () => {
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "UTILITY", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer requested WhatsApp appointment updates.",
    });
    let checks = 0;
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => {
        if (++checks > 1) throw new Error("Meta timed out before dispatch");
        return { name: "appointment_reminder", language: "en_US",
          category: "UTILITY", status: "APPROVED", body: "Your reminder." };
      },
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "appointment_reminder", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_APPROVAL_UNVERIFIED" });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toMatchObject([{
      status: "SUPPRESSED",
      metadata: expect.objectContaining({ suppressedReason: "WHATSAPP_TEMPLATE_APPROVAL_UNVERIFIED" }),
    }]);
  });

  it("suppresses stale appointment state after Meta approval, before provider dispatch", async () => {
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "UTILITY", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer requested appointment WhatsApp updates.",
    });
    const beforeDispatch = vi.fn(async () => {
      throw new AppError("APPOINTMENT_REVISION_CHANGED",
        "The appointment was rescheduled before dispatch.", 409);
    });
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => ({
        name: "appointment_reminder", language: "en_US",
        category: "UTILITY", status: "APPROVED", body: "Your reminder.",
      }),
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "appointment_reminder", languageCode: "en_US",
      beforeDispatch,
    })).rejects.toMatchObject({ code: "APPOINTMENT_REVISION_CHANGED" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toMatchObject([{
      status: "SUPPRESSED",
      metadata: expect.objectContaining({ suppressedReason: "APPOINTMENT_REVISION_CHANGED" }),
    }]);
  });

  it("suppresses a template when approval or consent changes before dispatch", async () => {
    const [conversation] = await db.select({ contactId: conversations.contactId })
      .from(conversations).where(eq(conversations.id, conversationId));
    await recordWhatsAppConsent({
      workspaceId, contactId: conversation.contactId, waId: "15551230000",
      category: "UTILITY", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer requested WhatsApp appointment updates.",
    });
    let reads = 0;
    const service = createWhatsAppOutboundService({
      resolveRuntime: async () => runtime,
      getApprovedTemplate: async () => ({
        name: "appointment_reminder", language: "en_US",
        category: "UTILITY", status: ++reads === 1 ? "APPROVED" : "PAUSED",
        body: "Your reminder.",
      }),
    });
    await expect(service.sendTemplate(workspaceId, conversationId, {
      senderType: "SYSTEM", templateName: "appointment_reminder", languageCode: "en_US",
    })).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toMatchObject([{
      status: "SUPPRESSED",
      metadata: expect.objectContaining({ suppressedReason: "WHATSAPP_TEMPLATE_NOT_APPROVED" }),
    }]);
  });

});
