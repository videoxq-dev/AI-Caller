import { getWorkspaceAgent } from "@/server/agent/service";
import { voiceConfigSchema } from "@/server/domain/onboarding/schemas";

export async function getVoiceConfig(workspaceId: string) {
  const agent = await getWorkspaceAgent(workspaceId);
  const behavior = agent?.behaviorSettings && typeof agent.behaviorSettings === "object"
    ? agent.behaviorSettings as Record<string, unknown>
    : {};
  const parsed = voiceConfigSchema.safeParse(behavior.voice);
  return {
    config: parsed.success ? parsed.data : voiceConfigSchema.parse(undefined),
    openingMessage: agent?.openingMessage?.trim() || null,
    assistantName: agent?.name?.trim() || "AI assistant",
  };
}
