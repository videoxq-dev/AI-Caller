import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiAgents } from "@/db/schema";
import { voiceConfigSchema } from "@/server/domain/onboarding/schemas";

export async function getVoiceConfig(workspaceId: string) {
  const [agent] = await db.select({
    behaviorSettings: aiAgents.behaviorSettings,
    openingMessage: aiAgents.openingMessage,
    name: aiAgents.name,
  }).from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId)).limit(1);
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
