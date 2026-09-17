import { z } from "zod";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { smsWebhookService } from "@/server/sms/service";

const paramsSchema = z.object({
  provider: z.enum(["telnyx", "twilio", "plivo"]),
  workspaceId: z.string().uuid(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; workspaceId: string }> },
) {
  try {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new AppError("INVALID_SMS_WEBHOOK_ROUTE", "Invalid SMS webhook route.", 404);
    const result = await smsWebhookService.ingest(request, parsed.data.workspaceId, parsed.data.provider);
    return Response.json(result, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
