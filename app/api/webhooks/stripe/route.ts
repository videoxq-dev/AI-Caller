import { getEnv } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { getStripeClient } from "@/server/billing/stripe-client";
import { processStripeWebhookEvent } from "@/server/billing/stripe-webhooks";

const MAX_STRIPE_WEBHOOK_BYTES = 512 * 1024;

async function rawWebhookBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_STRIPE_WEBHOOK_BYTES) {
    throw new AppError("STRIPE_WEBHOOK_TOO_LARGE", "Stripe webhook payload is too large.", 413);
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_STRIPE_WEBHOOK_BYTES) {
    throw new AppError("STRIPE_WEBHOOK_TOO_LARGE", "Stripe webhook payload is too large.", 413);
  }
  return body;
}

export async function POST(request: Request) {
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) throw new AppError("STRIPE_SIGNATURE_MISSING", "Stripe signature is required.", 401);
    const secret = getEnv().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new AppError("STRIPE_WEBHOOK_NOT_CONFIGURED", "Stripe webhook verification is not configured.", 503);

    const rawBody = await rawWebhookBody(request);
    let event;
    try {
      event = getStripeClient().webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new AppError("STRIPE_SIGNATURE_INVALID", "Stripe webhook signature is invalid.", 401);
    }

    const result = await processStripeWebhookEvent(event);
    return Response.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    return toErrorResponse(error);
  }
}
