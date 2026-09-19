import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, smsConsentEvents, smsConsents } from "@/db/schema";
import { normalizePhone } from "@/server/domain/core/schemas";
import { AppError } from "@/server/http/errors";
import type { SmsPurpose } from "./policy";

export type SmsConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
export type SmsConsentSource = "AI_CALL" | "HUMAN_CALL" | "INBOUND_SMS" | "WEB_FORM" | "STAFF_ENTRY" | "IMPORTED";
export type ConsentChange = {
  category: SmsPurpose;
  status: Exclude<SmsConsentStatus, "UNKNOWN">;
  source: SmsConsentSource;
  sourceReference?: string | null;
  consentStatement?: string | null;
};

export function normalizedSmsPhone(phone: string) {
  const normalized = normalizePhone(phone);
  if (!/^\+1[2-9]\d{9}$/.test(normalized)) throw new AppError("INVALID_SMS_PHONE", "A valid US phone number is required.", 422);
  return normalized;
}

export async function recordSmsConsent(workspaceId: string, contactId: string, phone: string, change: ConsentChange) {
  const phoneNumber = normalizedSmsPhone(phone);
  return db.transaction(async (tx) => {
    const [contact] = await tx.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId))).limit(1);
    if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
    const now = new Date();
    const values = {
      workspaceId, contactId, phoneNumber, category: change.category, status: change.status,
      source: change.source, sourceReference: change.sourceReference ?? null,
      consentStatement: change.consentStatement ?? null,
    };
    const [state] = await tx.insert(smsConsents).values({
      ...values, grantedAt: change.status === "OPTED_IN" ? now : null,
      revokedAt: change.status === "OPTED_OUT" ? now : null, updatedAt: now,
    }).onConflictDoUpdate({
      target: [smsConsents.workspaceId, smsConsents.contactId, smsConsents.phoneNumber, smsConsents.category],
      set: {
        status: change.status, source: change.source, sourceReference: values.sourceReference,
        consentStatement: values.consentStatement, updatedAt: now,
        grantedAt: change.status === "OPTED_IN" ? now : null,
        revokedAt: change.status === "OPTED_OUT" ? now : null,
      },
    }).returning();
    await tx.insert(smsConsentEvents).values({ ...values, occurredAt: now });
    return state;
  });
}

// Query by destination, not only contact: merged contacts must not bypass a newer opt-out.
export async function getSmsConsentStatus(workspaceId: string, phone: string, category: SmsPurpose): Promise<SmsConsentStatus> {
  const phoneNumber = normalizedSmsPhone(phone);
  const [latest] = await db.select({ status: smsConsentEvents.status })
    .from(smsConsentEvents)
    .where(and(eq(smsConsentEvents.workspaceId, workspaceId), eq(smsConsentEvents.phoneNumber, phoneNumber), eq(smsConsentEvents.category, category)))
    .orderBy(desc(smsConsentEvents.occurredAt), desc(smsConsentEvents.id)).limit(1);
  return latest?.status === "OPTED_IN" || latest?.status === "OPTED_OUT" ? latest.status : "UNKNOWN";
}

export function smsKeyword(text: string): "STOP" | "START" | "HELP" | null {
  const word = text.trim().replace(/[.!]+$/, "").toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(word)) return "STOP";
  if (["START", "UNSTOP", "JOIN"].includes(word)) return "START";
  if (word === "HELP") return "HELP";
  return null;
}

export function consentAllowsSend(input: { consent: SmsConsentStatus; purpose: SmsPurpose; currentConversationReply: boolean }) {
  if (input.consent === "OPTED_OUT") return false;
  if (input.consent === "OPTED_IN") return true;
  return input.purpose === "TRANSACTIONAL" && input.currentConversationReply;
}
