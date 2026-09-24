import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { getWhatsAppConsentStatus, recordWhatsAppConsent, validWhatsAppId } from "@/server/whatsapp/consent";

const inputSchema = z.object({
  waId: z.string().min(8).max(15),
  category: z.enum(["UTILITY", "MARKETING"]),
  status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  consentStatement: z.string().trim().max(2000),
}).strict().superRefine((value, ctx) => {
  if (value.status === "OPTED_IN" && value.consentStatement.length < 15) {
    ctx.addIssue({ code: "custom", path: ["consentStatement"],
      message: "Record how this customer explicitly agreed to WhatsApp messages." });
  }
});

async function contactIdentity(workspaceId: string, contactId: string) {
  const [contact] = await db.select({ id: contacts.id }).from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId))).limit(1);
  if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
  return db.select({ waId: contactIdentities.externalId }).from(contactIdentities)
    .where(and(eq(contactIdentities.workspaceId, workspaceId),
      eq(contactIdentities.contactId, contactId), eq(contactIdentities.channel, "WHATSAPP")))
    .limit(20);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.read");
    const { id } = await params;
    const identities = await contactIdentity(context.workspace.id, id);
    const items = await Promise.all(identities.map(async identity => ({
      waId: identity.waId,
      utility: await getWhatsAppConsentStatus(context.workspace.id, identity.waId, "UTILITY"),
      marketing: await getWhatsAppConsentStatus(context.workspace.id, identity.waId, "MARKETING"),
    })));
    return Response.json({ items }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());
    validWhatsAppId(input.waId);
    const identities = await contactIdentity(context.workspace.id, id);
    if (!identities.some(identity => identity.waId === input.waId)) {
      throw new AppError("WHATSAPP_IDENTITY_NOT_FOUND",
        "This WhatsApp identity does not belong to the selected customer.", 409);
    }
    const consent = await recordWhatsAppConsent({
      workspaceId: context.workspace.id, contactId: id, waId: input.waId,
      category: input.category, status: input.status, source: "STAFF_ENTRY",
      sourceReference: context.session.user.id, consentStatement: input.consentStatement,
    });
    return Response.json({ consent: {
      waId: consent.waId, category: consent.category,
      status: consent.status, updatedAt: consent.updatedAt,
    } }, { status: 201 });
  } catch (error) { return toErrorResponse(error); }
}
