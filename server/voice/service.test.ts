import { describe, expect, it, vi } from "vitest";
import type { VoiceProvider } from "@/server/providers/contracts";
import type { VoiceRuntime } from "@/server/providers/voice/runtime";
import { createVoiceWebhookService } from "./service";

function request() {
  return new Request("https://app.example.com/api/webhooks/voice/telnyx/11111111-1111-4111-8111-111111111111", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-signature": "valid" },
    body: "{}",
  });
}

function provider(): VoiceProvider {
  return {
    verifyWebhook: vi.fn(async () => true),
    normalizeWebhook: vi.fn(async () => [{
      type: "CALL_INITIATED" as const,
      externalEventId: "evt-suspended",
      externalCallId: "call-suspended",
      callControlId: "control-suspended",
      from: "+12025550100",
      to: "+12025550200",
      occurredAt: null,
    }]),
    answer: vi.fn(async () => undefined),
    gatherConsent: vi.fn(async () => undefined),
    startTranscription: vi.fn(async () => undefined),
    startRecording: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
  };
}

describe("voice webhook service", () => {
  it("authenticates and acknowledges suspended hosted webhooks without processing events", async () => {
    const voiceProvider = provider();
    const runtime: VoiceRuntime = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      mode: "HOSTED",
      providerName: "telnyx",
      integrationId: null,
      receiverNumber: "+12025550200",
      serviceStatus: "SUSPENDED",
      provider: voiceProvider,
    };
    const service = createVoiceWebhookService({
      resolveRuntime: async () => runtime,
      respond: vi.fn(),
      fetchRecording: vi.fn(),
      putRecording: vi.fn(),
    });

    await expect(service.ingest(request(), runtime.workspaceId, "telnyx")).resolves.toMatchObject({
      processed: 0,
      failed: 0,
      suppressed: 1,
    });
    expect(voiceProvider.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(voiceProvider.normalizeWebhook).toHaveBeenCalledTimes(1);
  });
});
