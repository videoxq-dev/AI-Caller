import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { contacts, conversations, creditWallets, hostedApiRateCards, hostedPhoneNumbers, messages, smsRegistrations, usageEvents, workspaces } from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { getSmsConsentStatus, recordSmsConsent } from "./consent";
import { sendSmsConversationTextWithRuntime } from "./outbound";
import { classifySmsPurpose } from "./classification";

vi.mock("./classification", () => ({
  classifySmsPurpose: vi.fn(async ({ message }: { message: string }) =>
    /discount|promotion|special offer/i.test(message) ? "MARKETING" : "TRANSACTIONAL"),
}));

describe("approved managed number outbound SMS", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";
  let numberId = "";
  const phone = "+12025550100";
  const send = vi.fn(async () => ({ externalId: "telnyx-message-1", status: "QUEUED" as const }));

  function runtime(): SmsRuntime {
    return {
      workspaceId, mode: "HOSTED", providerName: "telnyx", integrationId: null,
      senderNumber: "+12025550200", serviceStatus: "ACTIVE", messagingReadiness: "READY",
      provider: {
        send, verifyWebhook: vi.fn(async () => true), normalizeWebhook: vi.fn(async () => []),
      },
    };
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Approved SMS Sender" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Casey", phone }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
    const [number] = await db.insert(hostedPhoneNumbers).values({
      workspaceId, phoneNumber: "+12025550200", countryCode: "US", numberType: "local",
      status: "ACTIVE", messagingReadiness: "READY", providerMonthlyCostMicros: 1000000,
      providerUpfrontCostMicros: 0, purchaseCredits: 1, monthlyCredits: 1,
    }).returning();
    numberId = number.id;
    await db.insert(smsRegistrations).values({
      workspaceId, phoneNumberId: numberId, numberType: "local", status: "READY",
      approvedPolicy: {
        categories: ["TRANSACTIONAL"], allowEmbeddedLinks: true,
        description: "Customer appointments, reminders and service-related replies",
      },
    });
    await db.insert(creditWallets).values({ workspaceId, balance: 20 });
    await db.insert(hostedApiRateCards).values({
      capability: "SMS", provider: "telnyx", model: "", unit: "SMS_SEGMENT",
      costMicros: 450, unitsPerCost: 1, targetMarginBps: 5000,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }).onConflictDoNothing();
  });
  afterAll(async () => { await closeDatabase(); });

  it("sends a later appointment reminder with persisted transactional consent through the AI path", async () => {
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "WEB_FORM",
      sourceReference: "form", consentStatement: "Customer requested appointment reminders",
    });
    const msg = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Reminder: your appointment is tomorrow at 10 AM.",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "+12025550200", to: phone }));
    expect(msg.externalMessageId).toBe("telnyx-message-1");
    expect(msg.status).toBe("QUEUED");
    expect(msg.metadata.smsPurpose).toBe("TRANSACTIONAL");
    const [wallet] = await db.select().from(creditWallets);
    const billed = await db.select().from(usageEvents).where(and(
      eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.referenceId, msg.id),
    ));
    expect(billed).toHaveLength(1);
    expect(billed[0].creditsCharged).toBeGreaterThan(0);
    expect(wallet.balance).toBe(20 - billed[0].creditsCharged);
    expect(await getSmsConsentStatus(workspaceId, phone, "TRANSACTIONAL")).toBe("OPTED_IN");
  });

  it("allows a reply to the current SMS conversation without inventing recurring consent", async () => {
    await appendMessage(workspaceId, conversationId, {
      channel: "SMS", direction: "INBOUND", senderType: "CUSTOMER", contentType: "TEXT",
      body: "Where is my appointment?", provider: "telnyx", externalMessageId: "in-1",
    });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your appointment is at the downtown office.",
    })).resolves.toMatchObject({ status: "QUEUED" });
    expect(await getSmsConsentStatus(workspaceId, phone, "TRANSACTIONAL")).toBe("UNKNOWN");
  });

  it("uses identical purpose enforcement for staff and AI: promotional SMS cannot masquerade as appointment news", async () => {
    await db.update(conversations).set({ handlingMode: "HUMAN" }).where(eq(conversations.id, conversationId));
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "STAFF_ENTRY",
      consentStatement: "Customer requested appointment updates",
    });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: "Your appointment is tomorrow. Special offer: 25% discount.",
      metadata: { smsPurpose: "TRANSACTIONAL" },
    })).rejects.toMatchObject({ code: "SMS_CAMPAIGN_PURPOSE_NOT_APPROVED" });
    expect(send).not.toHaveBeenCalled();
    expect((await db.select().from(creditWallets))[0].balance).toBe(20);
    expect(classifySmsPurpose).toHaveBeenCalled();
  });

  it("blocks marketing without separate opt-in even after a mixed campaign is approved", async () => {
    await db.update(smsRegistrations).set({
      approvedPolicy: {
        categories: ["TRANSACTIONAL", "MARKETING"], allowEmbeddedLinks: true,
        description: "Appointments and separately opted-in offers",
      },
    }).where(eq(smsRegistrations.phoneNumberId, numberId));
    await db.update(conversations).set({ handlingMode: "HUMAN" }).where(eq(conversations.id, conversationId));
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "WEB_FORM",
      consentStatement: "Appointment reminders only",
    });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: "Special offer: 20% discount this weekend.",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops both SMS categories after explicit opt-out, even for a current customer reply", async () => {
    await appendMessage(workspaceId, conversationId, {
      channel: "SMS", direction: "INBOUND", senderType: "CUSTOMER", contentType: "TEXT",
      body: "Stop texting me", provider: "telnyx", externalMessageId: "in-stop",
    });
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_OUT", source: "INBOUND_SMS",
      sourceReference: "in-stop",
    });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your appointment is still confirmed.",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("never sends after approval is revoked even when a stale runtime says READY", async () => {
    await db.update(smsRegistrations).set({ status: "REJECTED", approvedPolicy: null })
      .where(eq(smsRegistrations.phoneNumberId, numberId));
    await recordSmsConsent(workspaceId, contactId, phone, {
      category: "TRANSACTIONAL", status: "OPTED_IN", source: "WEB_FORM",
      consentStatement: "Appointment reminders",
    });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your appointment has moved to 2 PM.",
    })).rejects.toMatchObject({ code: "SMS_CAMPAIGN_NOT_APPROVED" });
    expect(send).not.toHaveBeenCalled();
  });
});
