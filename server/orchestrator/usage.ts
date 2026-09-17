import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { debitCredits, refundCredits } from "@/server/credits/service";
import { getEnv } from "@/server/env";
import { resolveAIProvider } from "@/server/providers/registry";
import { resolveProviderRoute } from "@/server/providers/resolver";
import type { AIProvider } from "@/server/providers/contracts";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

function providerUsage(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const usage = (raw as { usage?: unknown }).usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : {};
}

export async function generateAIWithUsage(
  workspaceId: string,
  referenceId: string,
  messages: AIMessage[],
) {
  const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
  if (!route) throw new Error("No AI provider route is configured.");
  const provider = await resolveAIProvider(workspaceId);
  const callId = `${referenceId}:${randomUUID()}`;
  const hostedCredits = route.mode === "HOSTED" ? getEnv().HOSTED_AI_CREDITS_PER_CALL : 0;
  const providerName = route.mode === "HOSTED" ? getEnv().HOSTED_AI_PROVIDER : route.provider;

  if (hostedCredits > 0) {
    await debitCredits(workspaceId, hostedCredits, {
      reason: "Hosted AI response",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: callId,
    });
  }

  let response: Awaited<ReturnType<AIProvider["generate"]>>;
  try {
    response = await provider.generate({ messages });
  } catch (error) {
    if (hostedCredits > 0) {
      await refundCredits(workspaceId, hostedCredits, {
        reason: "Hosted AI provider call failed",
        referenceType: "ORCHESTRATOR_CALL",
        referenceId: callId,
      });
    }
    throw error;
  }

  await db.insert(usageEvents).values({
    workspaceId,
    capability: "AI_TEXT",
    provider: providerName,
    mode: route.mode,
    providerUsage: providerUsage(response.raw),
    creditsCharged: hostedCredits,
    referenceType: "CONVERSATION",
    referenceId,
  });

  return response;
}
