import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/db";
import { aiAgents, workspaces } from "@/db/schema";
import type { NormalizedVoiceEvent } from "@/server/providers/contracts";
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
  beforeEach(async () => { await db.delete(workspaces); });
  afterAll(async () => { await closeDatabase(); });
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
  it("acknowledges a paused agent call without Realtime streaming, recording or AI speech", async () => {
    const [workspace] = await db.insert(workspaces).values({ name: "Paused reception" }).returning();
    await db.insert(aiAgents).values({ workspaceId: workspace.id, name: "Mia", status: "PAUSED" });
    const voiceProvider = provider();
    const runtime: VoiceRuntime = {
      workspaceId: workspace.id, mode: "HOSTED", providerName: "telnyx",
      integrationId: null, receiverNumber: "+12025550200",
      serviceStatus: "ACTIVE", provider: voiceProvider,
    };
    const service = createVoiceWebhookService({
      resolveRuntime: async () => runtime, fetchRecording: vi.fn(), putRecording: vi.fn(),
    });
    const base = {
      externalCallId: "paused-call", callControlId: "paused-control", occurredAt: null,
    };
    const events: NormalizedVoiceEvent[] = [
      { ...base, type: "CALL_INITIATED", externalEventId: "paused-start",
        from: "+12025550100", to: "+12025550200" },
      { ...base, type: "CALL_ANSWERED", externalEventId: "paused-answer" },
      { ...base, type: "SPEAK_ENDED", externalEventId: "paused-notice-ended" },
    ];
    for (const event of events) {
      vi.mocked(voiceProvider.normalizeWebhook).mockResolvedValueOnce([event]);
      await expect(service.ingest(request(), workspace.id, "telnyx"))
        .resolves.toMatchObject({ processed: 1, failed: 0 });
    }
    expect(voiceProvider.answer).toHaveBeenCalledWith(expect.objectContaining({
      callControlId: "paused-control", streamUrl: null, bidirectional: false,
    }));
    expect(voiceProvider.speak).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("currently unavailable"),
    }));
    expect(voiceProvider.hangup).toHaveBeenCalledTimes(1);
    expect(voiceProvider.startRecording).not.toHaveBeenCalled();
    expect(voiceProvider.startTranscription).not.toHaveBeenCalled();
  });

});
