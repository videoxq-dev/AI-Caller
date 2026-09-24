import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { contacts, workspaces } from "@/db/schema";
import { getOrCreateOpenConversation } from "@/server/domain/core/repository";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { recordSmsConsent } from "./consent";
import { sendPreclassifiedAutomationSmsWithRuntime } from "./outbound";

describe("automated BYOP SMS consent enforcement", () => {
  let workspaceId = "";
  let contactId = "";
  let conversationId = "";
  const to = "+12025550100";
  const send = vi.fn(async () => ({ externalId: "byop-message-1", status: "QUEUED" as const }));

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
