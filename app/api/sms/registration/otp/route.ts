import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { hostedPhoneNumbers, smsRegistrations } from "@/db/schema";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { telnyxRegistrationClient } from "@/server/sms/registration-provider";
import { reconcileSmsRegistration } from "@/server/sms/registration-service";

const otpSchema = z.object({ pin: z.string().regex(/^\d{6}$/, "Enter the six-digit verification code.") }).strict();
const RETRY_AFTER_MS = 5 * 60 * 1000;

async function soleProprietorRegistration(workspaceId: string) {
  const [row] = await db.select({ registration: smsRegistrations }).from(smsRegistrations)
    .innerJoin(hostedPhoneNumbers, and(
      eq(hostedPhoneNumbers.id, smsRegistrations.phoneNumberId),
      eq(hostedPhoneNumbers.workspaceId, smsRegistrations.workspaceId),
    )).where(and(
      eq(smsRegistrations.workspaceId, workspaceId),
      eq(hostedPhoneNumbers.status, "ACTIVE"),
      eq(hostedPhoneNumbers.numberType, "local"),
    )).limit(1);
  const registration = row?.registration;
  if (!registration || !registration.carrierBrandId ||
    (registration.draft as { entityType?: string }).entityType !== "SOLE_PROPRIETOR" ||
    !["SUBMITTING", "PENDING"].includes(registration.status)) {
    throw new AppError("SMS_OTP_UNAVAILABLE", "Sole proprietor verification is not available for this registration.", 409);
  }
  return registration;
}

// Triggering identity verification can incur Telnyx charges. Only the workspace
// owner may invoke either mutating operation, and a repeated click cannot issue
// another PIN while a previous request may still be processing.
export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const registration = await soleProprietorRegistration(context.workspace.id);
    const client = telnyxRegistrationClient();
    const brand = await client.getBrand(registration.carrierBrandId!);
    if (["VERIFIED", "VETTED_VERIFIED"].includes(brand.identityStatus ?? "")) {
      return Response.json({ verified: true });
    }
    const now = new Date();
    const [claimed] = await db.update(smsRegistrations).set({ otpRequestedAt: now, updatedAt: now }).where(and(
      eq(smsRegistrations.workspaceId, context.workspace.id),
      eq(smsRegistrations.id, registration.id),
      or(isNull(smsRegistrations.otpRequestedAt),
        lt(smsRegistrations.otpRequestedAt, new Date(now.getTime() - RETRY_AFTER_MS))),
    )).returning({ id: smsRegistrations.id });
    if (!claimed) throw new AppError("SMS_OTP_RETRY_LATER", "A verification code was requested recently. Check your mobile phone before retrying.", 429);
    await client.requestSoleProprietorOtp(registration.carrierBrandId!);
    return Response.json({ requested: true }, { status: 202 });
  } catch (error) { return toErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    const { pin } = parseInput(otpSchema, await request.json());
    const registration = await soleProprietorRegistration(context.workspace.id);
    const client = telnyxRegistrationClient();
    await client.verifySoleProprietorOtp(registration.carrierBrandId!, pin);
    const status = await reconcileSmsRegistration(context.workspace.id, registration.id);
    return Response.json({ status }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}
