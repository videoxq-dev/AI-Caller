import { z } from "zod";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { voiceWebhookService } from "@/server/voice/service";

const paramsSchema = z.object({
  provider: z.literal("telnyx"),
  workspaceId: z.string().uuid(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; workspaceId: string }> },
) {
  try {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new AppError("INVALID_VOICE_WEBHOOK_ROUTE", "Invalid voice webhook route.", 404);
    const result = await voiceWebhookService.ingest(request, parsed.data.workspaceId, parsed.data.provider);
    return Response.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
