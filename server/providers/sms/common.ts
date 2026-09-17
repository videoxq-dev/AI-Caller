import { timingSafeEqual } from "node:crypto";
import type { SmsDeliveryStatus } from "../contracts";

export function parseFormBody(rawBody: string) {
  return new URLSearchParams(rawBody);
}

export function firstFormValue(form: URLSearchParams, key: string) {
  const value = form.get(key);
  return value?.trim() || null;
}

export function constantTimeTextEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeOccurredAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function mapSmsDeliveryStatus(value: unknown): SmsDeliveryStatus | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "accepted":
    case "scheduled":
    case "queued":
    case "sending":
      return "QUEUED";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "failed":
    case "undelivered":
    case "delivery_failed":
    case "delivery-failed":
    case "rejected":
    case "expired":
      return "FAILED";
    default:
      return null;
  }
}

export function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
