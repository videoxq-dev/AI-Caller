export const VOICE_TURN_SILENCE_MS = 1500;

export function estimateSpeechDurationMs(text: string, speakingRate = 1) {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const wordsPerSecond = 2.5 * Math.max(0.75, Math.min(1.25, speakingRate));
  return Math.max(400, Math.min(20_000, Math.round((words / wordsPerSecond) * 1000)));
}
