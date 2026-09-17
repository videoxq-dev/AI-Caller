import { z } from "zod";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { smsWebhookService } from "@/server/sms/service";

const paramsSchema = z.object({
  provider: z.enum(["telnyx", "twilio", "plivo"]),
  workspaceId: z.string().uuid(),
});

function xmlAcknowledgement(result: { queued: number; processed: number; duplicates: number; deferred: number }) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=utf-8",
      "cache-control": "no-store",
      "x-ai-caller-queued": String(result.queued),
      "x-ai-caller-processed": String(result.processed),
      "x-ai-caller-duplicates": String(result.duplicates),
      "x-ai-caller-deferred": String(result.deferred),
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; workspaceId: string }> },
) {
  try {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new AppError("INVALID_SMS_WEBHOOK_ROUTE", "Invalid SMS webhook route.", 404);
    const result = await smsWebhookService.ingest(request, parsed.data.workspaceId, parsed.data.provider);
    if (parsed.data.provider === "twilio" || parsed.data.provider === "plivo") {
      return xmlAcknowledgement(result);
    }
    return Response.json(result, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
