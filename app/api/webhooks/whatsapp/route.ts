import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { whatsAppWebhookService } from "@/server/whatsapp/service";

function sameToken(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = getEnv().META_WEBHOOK_VERIFY_TOKEN;

  if (!expected) return toErrorResponse(new AppError("WHATSAPP_WEBHOOK_NOT_CONFIGURED", "WhatsApp webhook verification is not configured.", 503));
  if (mode !== "subscribe" || !token || !challenge || !sameToken(token, expected)) {
    return toErrorResponse(new AppError("INVALID_WHATSAPP_WEBHOOK_CHALLENGE", "Invalid WhatsApp webhook verification challenge.", 403));
  }

  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const result = await whatsAppWebhookService.ingest(request);
    return Response.json(result, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
