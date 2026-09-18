import { describe, expect, it, vi } from "vitest";
import type { SMSProvider } from "@/server/providers/contracts";
import type { SmsRuntime } from "@/server/providers/sms/runtime";
import { sendSmsConversationTextWithRuntime } from "./outbound";

function runtime(readiness: SmsRuntime["messagingReadiness"]): SmsRuntime {
  const provider: SMSProvider = {
    send: vi.fn(async () => ({ externalId: "should-not-send", status: "QUEUED" as const })),
    verifyWebhook: vi.fn(async () => true),
    normalizeWebhook: vi.fn(async () => []),
  };
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    mode: "HOSTED",
    providerName: "telnyx",
    integrationId: null,
    senderNumber: "+12025550200",
    serviceStatus: "ACTIVE",
    messagingReadiness: readiness,
    provider,
  };
}

describe("hosted outbound SMS readiness", () => {
  it.each(["NOT_REGISTERED", "PENDING"] as const)(
    "fails closed before any send while messaging readiness is %s",
    async (readiness) => {
      const current = runtime(readiness);
      await expect(sendSmsConversationTextWithRuntime(
        current.workspaceId,
        "22222222-2222-4222-8222-222222222222",
        current,
        { senderType: "USER", text: "Hello" },
      )).rejects.toMatchObject({
        code: "SMS_REGISTRATION_REQUIRED",
        status: 409,
      });
      expect(current.provider.send).not.toHaveBeenCalled();
    },
  );

  it("uses a distinct rejected-registration error", async () => {
    const current = runtime("REJECTED");
    await expect(sendSmsConversationTextWithRuntime(
      current.workspaceId,
      "22222222-2222-4222-8222-222222222222",
      current,
      { senderType: "USER", text: "Hello" },
    )).rejects.toMatchObject({
      code: "SMS_REGISTRATION_REJECTED",
      status: 409,
    });
    expect(current.provider.send).not.toHaveBeenCalled();
  });
});
