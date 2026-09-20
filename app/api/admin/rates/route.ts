import { z } from "zod";
import { requirePlatformAdmin } from "@/server/admin/auth";
import { createAdminRateVersion, listAdminRateCards } from "@/server/admin/service";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

const createSchema = z.object({
  capability: z.enum(["AI_TEXT", "SMS", "VOICE"]),
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().max(120).optional(),
  unit: z.enum([
    "AI_INPUT_TOKEN", "AI_CACHED_INPUT_TOKEN", "AI_OUTPUT_TOKEN", "SMS_SEGMENT", "VOICE_MINUTE",
    "VOICE_REALTIME_AUDIO_INPUT_TOKEN", "VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN",
    "VOICE_REALTIME_AUDIO_OUTPUT_TOKEN", "VOICE_REALTIME_TEXT_INPUT_TOKEN",
    "VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN", "VOICE_REALTIME_TEXT_OUTPUT_TOKEN",
    "VOICE_REALTIME_CARRIER_MINUTE", "VOICE_REALTIME_STREAM_MINUTE",
    "VOICE_REALTIME_RECORDING_MINUTE",
  ]),
  costMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unitsPerCost: z.number().int().min(1).max(1_000_000_000),
  targetMarginBps: z.number().int().min(0).max(9500).default(5000),
  effectiveFrom: z.string().datetime(),
});

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request.headers);
    return Response.json({ items: await listAdminRateCards() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request.headers);
    const input = parseInput(createSchema, await request.json());
    const rate = await createAdminRateVersion({
      actorUserId: admin.session.user.id,
      ...input,
      effectiveFrom: new Date(input.effectiveFrom),
    });
    return Response.json({ rate }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
