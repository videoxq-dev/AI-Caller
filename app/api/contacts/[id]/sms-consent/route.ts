import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { getSmsConsentStatus, recordSmsConsent } from "@/server/sms/consent";

const inputSchema = z.object({
  phoneNumber: z.string().trim().min(8).max(40),
  category: z.enum(["TRANSACTIONAL", "MARKETING"]),
  status: z.enum(["OPTED_IN", "OPTED_OUT"]),
  consentStatement: z.string().trim().max(2000),
  sourceReference: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.status === "OPTED_IN" && value.consentStatement.length < 15) {
    ctx.addIssue({ code: "custom", path: ["consentStatement"], message: "Describe what the customer agreed to and how permission was obtained." });
  }
});

async function contactPhone(workspaceId: string, id: string) {
  const [contact] = await db.select().from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, id))).limit(1);
  if (!contact) throw new AppError("CONTACT_NOT_FOUND", "Contact not found.", 404);
  return contact.phone;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "team.read");
    const { id } = await params;
    const phone = await contactPhone(context.workspace.id, id);
    if (!phone || !/^\+1[2-9]\d{9}$/.test(phone)) {
      return Response.json({ phoneNumber: phone, transactional: "UNKNOWN", marketing: "UNKNOWN" });
    }
    const [transactional, marketing] = await Promise.all([
      getSmsConsentStatus(context.workspace.id, phone, "TRANSACTIONAL"),
      getSmsConsentStatus(context.workspace.id, phone, "MARKETING"),
    ]);
    return Response.json({ phoneNumber: phone, transactional, marketing }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "conversation.reply");
    const { id } = await params;
    const input = parseInput(inputSchema, await request.json());
    await contactPhone(context.workspace.id, id);
    const consent = await recordSmsConsent(context.workspace.id, id, input.phoneNumber, {
      category: input.category, status: input.status, source: "STAFF_ENTRY",
      sourceReference: input.sourceReference ?? context.session.user.id,
      consentStatement: input.consentStatement,
    });
    return Response.json({ consent: {
      category: consent.category, status: consent.status,
      phoneNumber: consent.phoneNumber, updatedAt: consent.updatedAt,
    } }, { status: 201 });
  } catch (error) { return toErrorResponse(error); }
}
