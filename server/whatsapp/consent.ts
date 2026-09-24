import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contactIdentities, contacts, whatsappConsentEvents, whatsappConsents } from "@/db/schema";
import { AppError } from "@/server/http/errors";

export type WhatsAppCategory = "UTILITY" | "MARKETING";
export type WhatsAppConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";

export function validWhatsAppId(value: string) {
  if (!/^\d{8,15}$/.test(value)) {
    throw new AppError("WHATSAPP_ID_INVALID", "A valid WhatsApp recipient identity is required.", 422);
  }
  return value;
}

export function whatsappPreferenceKeyword(text: string): "STOP" | "START" | null {
  const normalized = text.trim().replace(/[.!]+$/, "").toUpperCase();
  if (["STOP", "UNSUBSCRIBE", "STOPALL"].includes(normalized)) return "STOP";
  if (["START", "UNSTOP"].includes(normalized)) return "START";
  return null;
}

export async function getWhatsAppConsentStatus(
  workspaceId: string, waId: string, category: WhatsAppCategory,
): Promise<WhatsAppConsentStatus> {
  const recipient = validWhatsAppId(waId);
  const [last] = await db.select({ status: whatsappConsents.status }).from(whatsappConsents)
    .where(and(eq(whatsappConsents.workspaceId, workspaceId),
      eq(whatsappConsents.waId, recipient), eq(whatsappConsents.category, category)))
    .orderBy(desc(whatsappConsents.updatedAt), desc(whatsappConsents.status)).limit(1);
  return last?.status ?? "UNKNOWN";
}

type WhatsAppConsentChange = {
  workspaceId: string;
  contactId: string;
  waId: string;
  category: WhatsAppCategory;
  status: Exclude<WhatsAppConsentStatus, "UNKNOWN">;
  source: "INBOUND_WHATSAPP" | "STAFF_ENTRY";
  sourceReference?: string | null;
  consentStatement?: string | null;
};

async function writeWhatsAppConsents(
  input: Omit<WhatsAppConsentChange, "category"> & { categories: WhatsAppCategory[] },
) {
  const waId = validWhatsAppId(input.waId);
  return db.transaction(async tx => {
    const [identity] = await tx.select({ id: contactIdentities.id }).from(contactIdentities)
      .innerJoin(contacts, and(eq(contacts.id, contactIdentities.contactId),
        eq(contacts.workspaceId, input.workspaceId)))
      .where(and(eq(contactIdentities.workspaceId, input.workspaceId),
        eq(contactIdentities.contactId, input.contactId),
        eq(contactIdentities.channel, "WHATSAPP"),
        eq(contactIdentities.externalId, waId))).limit(1);
    if (!identity) throw new AppError("WHATSAPP_IDENTITY_NOT_FOUND",
      "WhatsApp permission requires this contact's verified WhatsApp identity.", 409);
    const now = new Date();
    const saved = [];
    for (const category of input.categories) {
      const values = {
        workspaceId: input.workspaceId, contactId: input.contactId, waId,
        category, status: input.status, source: input.source,
        sourceReference: input.sourceReference ?? null,
        consentStatement: input.consentStatement ?? null,
      };
      const [state] = await tx.insert(whatsappConsents).values({ ...values, updatedAt: now })
        .onConflictDoUpdate({
          target: [whatsappConsents.workspaceId, whatsappConsents.contactId,
            whatsappConsents.waId, whatsappConsents.category],
          set: { status: input.status, source: input.source,
            sourceReference: values.sourceReference, consentStatement: values.consentStatement,
            updatedAt: now },
        }).returning();
      await tx.insert(whatsappConsentEvents).values({ ...values, occurredAt: now });
      saved.push(state);
    }
    return saved;
  });
}

export async function recordWhatsAppConsent(input: WhatsAppConsentChange) {
  const [saved] = await writeWhatsAppConsents({ ...input, categories: [input.category] });
  return saved;
}

/** STOP is atomic across categories: marketing cannot remain enabled after a partial write. */
export async function recordWhatsAppKeywordConsent(
  input: Omit<WhatsAppConsentChange, "category" | "status"> & { keyword: "STOP" | "START" },
) {
  return writeWhatsAppConsents({
    ...input, status: input.keyword === "STOP" ? "OPTED_OUT" : "OPTED_IN",
    categories: input.keyword === "STOP" ? ["UTILITY", "MARKETING"] : ["UTILITY"],
  });
}
