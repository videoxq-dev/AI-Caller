import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { contacts, conversations, messages, workspaces } from "@/db/schema";
import { appendMessage, getOrCreateOpenConversation } from "@/server/domain/core/repository";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { recordSmsConsent } from "./consent";
import { classifySmsPurpose } from "./classification";
import { sendPreclassifiedAutomationSmsWithRuntime, sendSmsConversationTextWithRuntime } from "./outbound";

vi.mock("./classification", () => ({
  classifySmsPurpose: vi.fn(async ({ message }: { message: string }) =>
    /unclassifiable/i.test(message) ? "UNCERTAIN"
      : /discount|special offer|sale/i.test(message) ? "MARKETING" : "TRANSACTIONAL"),
}));

describe("automated BYOP SMS consent enforcement", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";
  const to = "+12025550100";
  let nextExternalId = 0;
  const send = vi.fn(async () => ({
    externalId: `byop-message-${++nextExternalId}`, status: "QUEUED" as const,
  }));

  function runtime(): SmsRuntime {
    return {
      workspaceId, mode: "BYOP", providerName: "twilio",
      integrationId: "11111111-1111-4111-8111-111111111111",
      senderNumber: "+12025550200", serviceStatus: null, messagingReadiness: null,
      provider: { send, verifyWebhook: vi.fn(async () => true), normalizeWebhook: vi.fn(async () => []) },
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    nextExternalId = 0;
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "BYOP automation SMS" }).returning();
    workspaceId = workspace.id;
    const [contact] = await db.insert(contacts).values({ workspaceId, name: "Customer", phone: to }).returning();
    contactId = contact.id;
    conversationId = (await getOrCreateOpenConversation(workspaceId, contactId)).id;
  });
  afterAll(async () => { await closeDatabase(); });

  async function consent(category: "MARKETING" | "TRANSACTIONAL", status: "OPTED_IN" | "OPTED_OUT") {
    await recordSmsConsent(workspaceId, contactId, to, {
      category, status, source: "WEB_FORM",
      consentStatement: "Customer SMS preference",
    });
  }


  it("blocks unsolicited AI and staff SMS without consent on the ordinary BYOP path", async () => {
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your appointment is tomorrow.",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    await db.update(conversations).set({ handlingMode: "HUMAN" })
      .where(eq(conversations.id, conversationId));
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: "Your appointment is tomorrow.",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(classifySmsPurpose).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("allows consented AI and staff replies with the classified purpose in both audit records", async () => {
    await consent("TRANSACTIONAL", "OPTED_IN");
    const ai = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your appointment is confirmed.",
      metadata: { smsPurpose: "MARKETING" },
    });
    await db.update(conversations).set({ handlingMode: "HUMAN" })
      .where(eq(conversations.id, conversationId));
    const staff = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: "Your appointment has been rescheduled.",
      metadata: { smsPurpose: "MARKETING" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(ai.metadata).toMatchObject({ smsPurpose: "TRANSACTIONAL", mode: "BYOP" });
    expect(staff.metadata).toMatchObject({ smsPurpose: "TRANSACTIONAL", mode: "BYOP" });
    expect(classifySmsPurpose).toHaveBeenCalledTimes(2);
  });

  it("does not allow staff or AI to disguise promotional BYOP SMS as transactional", async () => {
    await consent("TRANSACTIONAL", "OPTED_IN");
    const promotionalText = "Your booking is confirmed. Special offer: 20% off.";
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: promotionalText, metadata: { smsPurpose: "TRANSACTIONAL" },
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    await db.update(conversations).set({ handlingMode: "HUMAN" })
      .where(eq(conversations.id, conversationId));
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: promotionalText, metadata: { smsPurpose: "TRANSACTIONAL" },
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).not.toHaveBeenCalled();
    await consent("MARKETING", "OPTED_IN");
    const sent = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "USER", text: promotionalText, metadata: { smsPurpose: "TRANSACTIONAL" },
    });
    expect(sent.metadata.smsPurpose).toBe("MARKETING");
    expect(send).toHaveBeenCalledOnce();
  });

  it("allows a relevant customer-initiated reply but not an unrelated destination or a reply after STOP", async () => {
    await appendMessage(workspaceId, conversationId, {
      channel: "SMS", direction: "INBOUND", senderType: "CUSTOMER",
      contentType: "TEXT", body: "Can you confirm my booking?",
      provider: "twilio", externalMessageId: "inbound-byop-reply",
      metadata: { senderNumber: to },
    });
    const replied = await sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your booking is confirmed.",
    });
    expect(replied.metadata.smsPurpose).toBe("TRANSACTIONAL");
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your booking is confirmed.", to: "+12025550111",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    await consent("TRANSACTIONAL", "OPTED_OUT");
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Your booking is confirmed.",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails closed for uncertain BYOP messages and rejects unsafe links before creating an outbound record", async () => {
    await consent("TRANSACTIONAL", "OPTED_IN");
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Unclassifiable service note.",
    })).rejects.toMatchObject({ code: "SMS_CAMPAIGN_REVIEW_REQUIRED" });
    await expect(sendSmsConversationTextWithRuntime(workspaceId, conversationId, runtime(), {
      senderType: "AI", text: "Book here: http://example.com/booking",
    })).rejects.toMatchObject({ code: "SMS_UNSAFE_LINK" });
    expect(send).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("does not send proactive SMS through a connected BYOP provider without recipient consent", async () => {
    await expect(sendPreclassifiedAutomationSmsWithRuntime(workspaceId, conversationId, runtime(), {
      text: "Your appointment is confirmed.", classifiedPurpose: "TRANSACTIONAL",
      idempotencyKey: "byop-automation-1",
    })).rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a consented transactional automation and retains purpose audit metadata", async () => {
    await consent("TRANSACTIONAL", "OPTED_IN");
    const result = await sendPreclassifiedAutomationSmsWithRuntime(workspaceId, conversationId, runtime(), {
      text: "Your appointment is confirmed.", classifiedPurpose: "TRANSACTIONAL",
      idempotencyKey: "byop-automation-2",
    });
    expect(result).toMatchObject({ status: "QUEUED", metadata: { smsPurpose: "TRANSACTIONAL" } });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to, idempotencyKey: "byop-automation-2" }));
  });

  it("never reuses transactional consent for a promotional automation or after opt-out", async () => {
    await consent("TRANSACTIONAL", "OPTED_IN");
    const message = {
      text: "Your booking is confirmed. Special offer: 20% off.",
      classifiedPurpose: "TRANSACTIONAL" as const,
      idempotencyKey: "byop-automation-3",
    };
    await expect(sendPreclassifiedAutomationSmsWithRuntime(workspaceId, conversationId, runtime(), message))
      .rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    await consent("MARKETING", "OPTED_IN");
    const success = await sendPreclassifiedAutomationSmsWithRuntime(workspaceId, conversationId, runtime(), message);
    expect(success.metadata).toMatchObject({ smsPurpose: "MARKETING" });
    expect(send).toHaveBeenCalledOnce();
    await consent("MARKETING", "OPTED_OUT");
    await expect(sendPreclassifiedAutomationSmsWithRuntime(workspaceId, conversationId, runtime(), message))
      .rejects.toMatchObject({ code: "SMS_CONSENT_REQUIRED" });
    expect(send).toHaveBeenCalledOnce();
  });
});
