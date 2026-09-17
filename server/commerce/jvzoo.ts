import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/server/http/errors";
import { getEnv } from "@/server/env";
import type { CommerceAdapter, NormalizedPurchaseEvent } from "./types";

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(value);
}

export function calculateJvzooVerify(payload: Record<string, unknown>, secret: string): string {
  const keys = Object.keys(payload).filter((key) => key.toLowerCase() !== "cverify").sort();
  let material = "";
  for (const key of keys) material += `${canonicalValue(payload[key])}|`;
  material += secret;
  return createHash("sha1").update(material, "utf8").digest("hex").slice(0, 8).toUpperCase();
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a.toUpperCase());
  const right = Buffer.from(b.toUpperCase());
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function parsePayload(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_IPN", "Invalid JVZoo payload.", 400);
    return value as Record<string, unknown>;
  }

  const text = await request.text();
  const params = new URLSearchParams(text);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) payload[key] = value;
  return payload;
}

function getString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function parseTimestamp(payload: Record<string, unknown>): Date {
  const candidate = getString(payload, "transaction_time", "created_at", "ctranstime");
  if (!candidate) return new Date();
  if (/^\d+$/.test(candidate)) {
    const seconds = Number(candidate);
    const date = new Date(seconds * 1000);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export class JvzooCommerceAdapter implements CommerceAdapter {
  async verifyAndNormalize(request: Request): Promise<NormalizedPurchaseEvent> {
    const payload = await parsePayload(request);
    const env = getEnv();
    if (!env.JVZOO_IPN_SECRET) throw new AppError("JVZOO_NOT_CONFIGURED", "JVZoo IPN secret is not configured.", 503);

    const received = getString(payload, "cverify");
    if (!received) throw new AppError("INVALID_IPN_SIGNATURE", "Missing JVZoo verification signature.", 403);
    const expected = calculateJvzooVerify(payload, env.JVZOO_IPN_SECRET);
    if (!constantTimeEqual(received, expected)) throw new AppError("INVALID_IPN_SIGNATURE", "Invalid JVZoo verification signature.", 403);

    const eventType = (getString(payload, "transaction_type", "ctransaction") ?? "UNKNOWN").toUpperCase();
    const productId = getString(payload, "product_id", "cproditem");
    const purchaseId = getString(payload, "receipt_id", "transaction_id", "ctransreceipt");
    const email = getString(payload, "customer_email", "ccustemail")?.toLowerCase();
    const firstName = getString(payload, "customer_first_name");
    const lastName = getString(payload, "customer_last_name");
    const legacyName = getString(payload, "ccustname");

    if (!productId || !purchaseId || !email) {
      throw new AppError("INVALID_IPN", "JVZoo payload is missing product, receipt, or customer email.", 400);
    }

    const customerName = [firstName, lastName].filter(Boolean).join(" ").trim() || legacyName || email.split("@")[0];
    return {
      source: "JVZOO",
      externalEventId: `${purchaseId}:${eventType}`,
      externalPurchaseId: purchaseId,
      eventType,
      status: getString(payload, "status"),
      productId,
      productName: getString(payload, "product_name", "cprodtitle"),
      customerEmail: email,
      customerFirstName: firstName,
      customerLastName: lastName,
      customerName,
      purchasedAt: parseTimestamp(payload),
      amount: getString(payload, "amount", "transaction_amount", "ctransamount"),
      raw: payload,
    };
  }
}
