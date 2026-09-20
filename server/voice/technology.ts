import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceVoiceTechnology } from "@/db/schema";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/http/errors";
import { getCreditBalance } from "@/server/credits/service";
import { getManagedPhoneNumber } from "@/server/phone-numbers/service";
import { loadRealtimeRateSnapshots, type RealtimeVoiceModel } from "@/server/billing/realtime-voice";

export type VoiceTechnology = "STANDARD" | "REALTIME";
export const REALTIME_MIN_START_CREDITS = 500;

export async function getVoiceTechnology(workspaceId: string) {
  const [row] = await db.select().from(workspaceVoiceTechnology)
    .where(eq(workspaceVoiceTechnology.workspaceId, workspaceId)).limit(1);
  return {
    technology: row?.technology ?? "STANDARD" as VoiceTechnology,
    realtimeModel: row?.realtimeModel ?? "gpt-realtime-2.1" as RealtimeVoiceModel,
  };
}

export function hasRealtimeGatewayConfiguration() {
  const env = getEnv();
  if (!env.HOSTED_AI_API_KEY || !env.VOICE_GATEWAY_URL || !env.VOICE_REALTIME_ENABLED) return false;
  const url = new URL(env.VOICE_GATEWAY_URL);
  return url.protocol === "wss:" || (env.NODE_ENV !== "production" && url.protocol === "ws:");
}

export async function requireRealtimeReady(workspaceId: string, model: RealtimeVoiceModel) {
  if (!hasRealtimeGatewayConfiguration()) {
    throw new AppError("REALTIME_NOT_CONFIGURED",
      "Realtime voice is not available until the hosted AI key and secure voice gateway are configured.", 503);
  }
  const number = await getManagedPhoneNumber(workspaceId);
  if (!number || number.status !== "ACTIVE" || number.numberType !== "local") {
    throw new AppError("REALTIME_NUMBER_NOT_READY",
      "Realtime requires an active managed US local number.", 409);
  }
  // Fail closed on missing component rates; a session must never begin with
  // only the AI rates or an outdated model price.
  const rateSnapshot = await loadRealtimeRateSnapshots(model);
  const balance = await getCreditBalance(workspaceId);
  if (balance < REALTIME_MIN_START_CREDITS) {
    throw new AppError("REALTIME_CREDITS_REQUIRED",
      `Realtime voice requires at least ${REALTIME_MIN_START_CREDITS} credits before answering a call.`, 402);
  }
  return rateSnapshot;
}

export async function setVoiceTechnology(workspaceId: string,
  input: { technology: VoiceTechnology; realtimeModel: RealtimeVoiceModel }) {
  if (input.technology === "REALTIME") await requireRealtimeReady(workspaceId, input.realtimeModel);
  const [row] = await db.insert(workspaceVoiceTechnology)
    .values({ workspaceId, technology: input.technology, realtimeModel: input.realtimeModel })
    .onConflictDoUpdate({ target: workspaceVoiceTechnology.workspaceId, set: {
      technology: input.technology, realtimeModel: input.realtimeModel, updatedAt: new Date(),
    } }).returning();
  return { technology: row.technology, realtimeModel: row.realtimeModel };
}
