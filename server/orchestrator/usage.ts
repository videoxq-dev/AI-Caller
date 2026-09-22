import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { usageEvents } from "@/db/schema";
import { loadHostedRateSnapshot, quoteHostedUsage } from "@/server/billing/pricing";
import {
  releaseCreditReservation,
  reserveCredits,
  settleCreditReservation,
} from "@/server/credits/service";
import { isE2EProviderFixtureMode } from "@/server/providers/e2e-fixtures";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";
import { hostedAIModel } from "@/server/providers/ai";
import { resolveAIProvider } from "@/server/providers/registry";
import { resolveProviderRoute } from "@/server/providers/resolver";
import type { AIProvider } from "@/server/providers/contracts";

type AIMessage = Parameters<AIProvider["generate"]>[0]["messages"][number];

type NormalizedAIUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reported: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function usageInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function normalizeAIProviderUsage(raw: unknown): NormalizedAIUsage {
  const response = record(raw);
  const usage = record(response.usage);
  const metadata = record(response.usageMetadata);
  const inputDetails = record(usage.input_tokens_details ?? usage.prompt_tokens_details);

  const inputTokens = usageInteger(
    usage.input_tokens
      ?? usage.prompt_tokens
      ?? metadata.promptTokenCount,
  );
  const cachedInputTokens = Math.min(inputTokens, usageInteger(
    inputDetails.cached_tokens
      ?? usage.cached_tokens
      ?? metadata.cachedContentTokenCount,
  ));
  const outputTokens = usageInteger(
    usage.output_tokens
      ?? usage.completion_tokens
      ?? metadata.candidatesTokenCount,
  );
  const totalTokens = usageInteger(
    usage.total_tokens
      ?? metadata.totalTokenCount,
  ) || inputTokens + outputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    reported: inputTokens > 0 || outputTokens > 0,
  };
}

function estimatedInputTokenUpperBound(messages: AIMessage[]) {
  const bytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.role, "utf8") + Buffer.byteLength(message.content, "utf8"),
    0,
  );
  return Math.max(1, bytes + (messages.length * 16) + 1024);
}

export async function generateAIWithUsage(
  workspaceId: string,
  referenceId: string,
  messages: AIMessage[],
  tracking: { taskRunId?: string | null } = {},
) {
  const route = await resolveProviderRoute(workspaceId, "AI_TEXT");
  if (!route) throw new Error("No AI provider route is configured.");
  const provider = await resolveAIProvider(workspaceId);
  const callId = `${referenceId}:${randomUUID()}`;
  const hosted = route.mode === "HOSTED";
  const providerName = hosted ? getEnv().HOSTED_AI_PROVIDER : route.provider;
  const model = hosted ? hostedAIModel() : null;
  const maxOutputTokens = hosted ? getEnv().HOSTED_AI_MAX_OUTPUT_TOKENS : undefined;

  let reservation: Awaited<ReturnType<typeof reserveCredits>> | null = null;
  let rates: Awaited<ReturnType<typeof loadHostedRateSnapshot>> = [];
  let reservedQuote: ReturnType<typeof quoteHostedUsage> | null = null;

  if (hosted) {
    rates = await loadHostedRateSnapshot({
      capability: "AI_TEXT",
      provider: providerName,
      model,
      units: ["AI_INPUT_TOKEN", "AI_CACHED_INPUT_TOKEN", "AI_OUTPUT_TOKEN"],
    });
    reservedQuote = quoteHostedUsage(rates, [
      { unit: "AI_INPUT_TOKEN", units: estimatedInputTokenUpperBound(messages) },
      { unit: "AI_OUTPUT_TOKEN", units: maxOutputTokens ?? 0 },
    ]);
    if (reservedQuote.credits <= 0) throw new Error("Hosted AI reservation must be positive.");
    reservation = await reserveCredits(workspaceId, reservedQuote.credits, {
      referenceType: "ORCHESTRATOR_RESERVATION",
      referenceId: callId,
    });
  }

  let response: Awaited<ReturnType<AIProvider["generate"]>>;
  try {
    response = await provider.generate({
      messages,
      ...(hosted ? { model: model ?? undefined, maxOutputTokens } : {}),
    });
  } catch (error) {
    if (reservation) {
      await releaseCreditReservation(workspaceId, reservation.id).catch((releaseError) => {
        logger.error(
          { err: releaseError, workspaceId, referenceId, callId },
          "Failed to release hosted AI credit reservation after provider failure",
        );
      });
    }
    throw error;
  }

  const reportedUsage = normalizeAIProviderUsage(response.raw);
  const normalized = !reportedUsage.reported && isE2EProviderFixtureMode()
    ? {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 110,
        reported: true,
      }
    : reportedUsage;

  let creditsCharged = 0;
  let providerCostMicros = 0;
  let billedUnits: Record<string, number> = {};
  let pricingDetails: Record<string, unknown> = {};

  if (hosted && reservation && reservedQuote) {
    const actualQuote = normalized.reported
      ? quoteHostedUsage(rates, [
          { unit: "AI_INPUT_TOKEN", units: Math.max(0, normalized.inputTokens - normalized.cachedInputTokens) },
          { unit: "AI_CACHED_INPUT_TOKEN", units: normalized.cachedInputTokens },
          { unit: "AI_OUTPUT_TOKEN", units: normalized.outputTokens },
        ])
      : reservedQuote;

    await settleCreditReservation(workspaceId, reservation.id, actualQuote.credits, {
      reason: "Hosted AI response",
      referenceType: "ORCHESTRATOR_CALL",
      referenceId: callId,
    });
    creditsCharged = actualQuote.credits;
    providerCostMicros = actualQuote.providerCostMicros;
    billedUnits = actualQuote.billedUnits;
    pricingDetails = {
      ...actualQuote.pricingDetails,
      estimatedUsage: !normalized.reported,
    };
  }

  try {
    await db.insert(usageEvents).values({
      workspaceId,
      capability: "AI_TEXT",
      provider: providerName,
      mode: route.mode,
      providerUsage: normalized,
      creditsCharged,
      providerCostMicros,
      billedUnits,
      pricingDetails,
      referenceType: "CONVERSATION",
      referenceId,
      taskRunId: tracking.taskRunId ?? null,
    });
  } catch (error) {
    logger.error(
      { err: error, workspaceId, referenceId, callId, provider: providerName, mode: route.mode },
      "Failed to persist AI usage after successful provider call",
    );
  }

  return response;
}
