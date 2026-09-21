import { describe, expect, it } from "vitest";
import { resolveVoiceProfile } from "./voices";

describe("voice profiles", () => {
  it("maps each configured phone persona to both Standard and Realtime providers", () => {
    expect(resolveVoiceProfile("ava-us-1")).toMatchObject({
      providerVoiceId: "Azure.en-US-AvaMultilingualNeural",
      realtimeVoiceId: "marin",
    });
    expect(resolveVoiceProfile("marcus-us-1")).toMatchObject({
      providerVoiceId: "Azure.en-US-BrianMultilingualNeural",
      realtimeVoiceId: "cedar",
    });
    expect(resolveVoiceProfile("sofia-us-1")).toMatchObject({
      providerVoiceId: "Azure.en-US-EmmaMultilingualNeural",
      realtimeVoiceId: "coral",
    });
    expect(resolveVoiceProfile("james-us-1")).toMatchObject({
      providerVoiceId: "Azure.en-US-AndrewMultilingualNeural",
      realtimeVoiceId: "verse",
    });
  });
});
