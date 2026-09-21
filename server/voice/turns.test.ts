import { beforeEach, describe, expect, it, vi } from "vitest";
import { processVoiceTurn } from "./turns";
import { claimVoiceTurn, finishVoiceTurn, isVoiceTurnCurrent, yieldSupersededVoiceTurn } from "./repository";
import { responseOrchestrator } from "@/server/orchestrator";
import { getConversationById, appendMessage } from "@/server/domain/core/repository";
import { enqueueUniqueJobAt } from "@/server/jobs";
import { resolveVoiceRuntime } from "@/server/providers/voice/runtime";
import { appendVoiceTranscriptSegment } from "./repository";
import { resolveVoiceProfile } from "./voices";

vi.mock("./repository", () => ({
  claimVoiceTurn: vi.fn(),
  finishVoiceTurn: vi.fn(),
  isVoiceTurnCurrent: vi.fn(),
  yieldSupersededVoiceTurn: vi.fn(),
  appendVoiceTranscriptSegment: vi.fn(),
  restoreVoiceTurn: vi.fn(),
}));
vi.mock("@/server/orchestrator", () => ({ responseOrchestrator: { respond: vi.fn() } }));
vi.mock("@/server/domain/core/repository", () => ({
  getConversationById: vi.fn(), appendMessage: vi.fn(),
}));
vi.mock("@/server/jobs", () => ({ enqueueUniqueJobAt: vi.fn() }));
vi.mock("@/server/providers/voice/runtime", () => ({ resolveVoiceRuntime: vi.fn() }));
vi.mock("./config", () => ({
  getVoiceConfig: vi.fn(async () => ({ config: {
    profileKey: "test", language: "en-US", speakingRate: 1,
  } })),
}));
vi.mock("./voices", () => ({ resolveVoiceProfile: vi.fn(() => ({ providerVoiceId: "test-voice" })) }));
vi.mock("@/server/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ids = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  callId: "22222222-2222-4222-8222-222222222222",
  eventId: "first-final",
};

const call = {
  id: ids.callId,
  callControlId: "call-control",
  conversationId: "33333333-3333-4333-8333-333333333333",
  provider: "telnyx",
  status: "ACTIVE",
  recordingConsentStatus: "ANNOUNCED",
  startedAt: new Date(),
  mode: "AI_FIRST",
  metadata: {
    pendingVoiceTurnAt: new Date().toISOString(),
    voiceProfile: "marcus-us-1",
    language: "en-GB",
    speakingRate: 0.85,
  },
};

describe("live voice response gating", () => {
  const speak = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimVoiceTurn).mockResolvedValue(call as unknown as Awaited<ReturnType<typeof claimVoiceTurn>>);
    vi.mocked(yieldSupersededVoiceTurn).mockResolvedValue(null);
    vi.mocked(isVoiceTurnCurrent).mockResolvedValue(true);
    vi.mocked(finishVoiceTurn).mockResolvedValue(call as unknown as Awaited<ReturnType<typeof finishVoiceTurn>>);
    vi.mocked(getConversationById).mockResolvedValue({ handlingMode: "AI" } as Awaited<ReturnType<typeof getConversationById>>);
    vi.mocked(resolveVoiceRuntime).mockResolvedValue({ provider: { speak } } as unknown as Awaited<ReturnType<typeof resolveVoiceRuntime>>);
    vi.mocked(appendVoiceTranscriptSegment).mockResolvedValue({ id: "segment-id" } as Awaited<ReturnType<typeof appendVoiceTranscriptSegment>>);
    vi.mocked(appendMessage).mockResolvedValue({ id: "message-id" } as Awaited<ReturnType<typeof appendMessage>>);
    vi.mocked(enqueueUniqueJobAt).mockResolvedValue("job-id");
  });

  it("drops an answer superseded while AI was generating and only schedules the latest caller final", async () => {
    vi.mocked(responseOrchestrator.respond).mockResolvedValue({
      reply: "I'll book your office cleaning now.",
      handlingMode: "AI",
      action: { type: "NONE" },
      toolResult: { kind: "none", data: {} },
    });
    vi.mocked(yieldSupersededVoiceTurn).mockResolvedValue("latest-final");
    await expect(processVoiceTurn(ids)).resolves.toMatchObject({ status: "SUPERSEDED" });
    expect(speak).not.toHaveBeenCalled();
    expect(appendVoiceTranscriptSegment).not.toHaveBeenCalled();
    expect(enqueueUniqueJobAt).toHaveBeenCalledWith(
      "voice.respond-turn",
      `${ids.callId}:latest-final:superseded`,
      { ...ids, eventId: "latest-final" },
      expect.any(Date),
    );
  });

  it("uses the per-call voice snapshot instead of switching when workspace settings change mid-call", async () => {
    vi.mocked(responseOrchestrator.respond).mockResolvedValue({
      reply: "The selected voice should stay consistent.",
      handlingMode: "AI",
      action: { type: "NONE" },
      toolResult: { kind: "none", data: {} },
    });

    await expect(processVoiceTurn(ids)).resolves.toMatchObject({ status: "SPOKEN" });

    expect(resolveVoiceProfile).toHaveBeenCalledWith("marcus-us-1");
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({
      voice: "test-voice",
      language: "en-GB",
      speakingRate: 0.85,
    }));
  });

  it("speaks a truthful human-follow-up acknowledgement even after escalation changes conversation ownership", async () => {
    const reply = "I've flagged your request for our team to follow up. I can't transfer this call live.";
    vi.mocked(responseOrchestrator.respond).mockResolvedValue({
      reply,
      handlingMode: "HUMAN",
      action: { type: "ESCALATE", reason: "Caller requested a human during a phone call." },
      toolResult: { kind: "escalation", data: { handlingMode: "HUMAN" } },
    });
    vi.mocked(getConversationById).mockResolvedValue({ handlingMode: "HUMAN" } as Awaited<ReturnType<typeof getConversationById>>);
    await expect(processVoiceTurn(ids)).resolves.toMatchObject({ status: "SPOKEN" });
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: reply }));
    expect(finishVoiceTurn).toHaveBeenCalledWith(
      ids.workspaceId, ids.callId, ids.eventId, "AI_SPEAKING", "HUMAN",
    );
    expect(appendMessage).toHaveBeenCalledWith(
      ids.workspaceId, call.conversationId,
      expect.objectContaining({ body: reply, contentType: "CALL_TRANSCRIPT" }),
    );
  });

  it("also aborts if the caller speaks after the first stale-turn check but before the final speech transition", async () => {
    vi.mocked(responseOrchestrator.respond).mockResolvedValue({
      reply: "Old answer",
      handlingMode: "AI",
      action: { type: "NONE" },
      toolResult: { kind: "none", data: {} },
    });
    vi.mocked(finishVoiceTurn).mockResolvedValue(null);
    vi.mocked(yieldSupersededVoiceTurn).mockResolvedValueOnce(null).mockResolvedValueOnce("final-after-model");
    await expect(processVoiceTurn(ids)).resolves.toMatchObject({ status: "SUPERSEDED" });
    expect(speak).not.toHaveBeenCalled();
    expect(enqueueUniqueJobAt).toHaveBeenCalledWith(
      "voice.respond-turn",
      `${ids.callId}:final-after-model:pre-speak-superseded`,
      { ...ids, eventId: "final-after-model" },
      expect.any(Date),
    );
  });
});
