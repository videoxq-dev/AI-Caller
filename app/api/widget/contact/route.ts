import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { normalizedSmsPhone, recordSmsConsent } from "@/server/sms/consent";
import { getPublicWebchatWidget, resolveWebchatSession } from "@/server/webchat/repository";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(8).max(40),
  transactionalSmsConsent: z.boolean().default(false),
}).strict();

async function authorized(request: Request) {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError("WEBCHAT_UNAUTHORIZED", "A chat session is required.", 401);
  const resolved = await resolveWebchatSession(token);
  if (!resolved) throw new AppError("WEBCHAT_SESSION_EXPIRED", "Chat session expired.", 401);
  return resolved;
}

export async function GET(request: Request) {
  try {
    const resolved = await authorized(request);
    const [contact] = await db.select().from(contacts).where(and(
      eq(contacts.workspaceId, resolved.session.workspaceId),
      eq(contacts.id, resolved.session.contactId),
    )).limit(1);
    if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
    return Response.json({
      name: contact.name ?? "", email: contact.email ?? "", phone: contact.phone ?? "",
      captured: Boolean(contact.name && contact.email && contact.phone),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const resolved = await authorized(request);
    const input = parseInput(inputSchema, await request.json());
    const phoneNumber = input.phone ? normalizedSmsPhone(input.phone) : null;
    if (input.transactionalSmsConsent && !phoneNumber) throw new AppError("SMS_PHONE_REQUIRED", "Enter a phone number to opt in.", 422);
    const widget = await getPublicWebchatWidget(resolved.widget.publicKey);
    if (!widget) throw new AppError("WIDGET_NOT_FOUND", "Web chat widget not found.", 404);
    if (input.transactionalSmsConsent && !widget.smsTermsUrl) throw new AppError("SMS_TERMS_NOT_CONFIGURED", "SMS terms are not configured.", 409);
    const [contact] = await db.update(contacts).set({
      name: input.name, email: input.email.toLowerCase(), phone: phoneNumber, updatedAt: new Date(),
    }).where(and(
      eq(contacts.workspaceId, resolved.session.workspaceId),
      eq(contacts.id, resolved.session.contactId),
    )).returning({ id: contacts.id });
    if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
    if (input.transactionalSmsConsent && phoneNumber) {
      await recordSmsConsent(resolved.session.workspaceId, contact.id, phoneNumber, {
        category: "TRANSACTIONAL", status: "OPTED_IN", source: "WEB_FORM",
        sourceReference: resolved.session.id,
        consentStatement: "Appointment confirmations, reminders, and related SMS updates from " + widget.businessName + ". Terms: " + widget.smsTermsUrl,
      });
    }
    return Response.json({ captured: true });
  } catch (error) { return toErrorResponse(error); }
}
