import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { businessProfiles, hostedPhoneNumbers, smsRegistrations } from "@/db/schema";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { submitSmsRegistration } from "@/server/sms/registration-service";
import { ensureWebchatWidget } from "@/server/webchat/repository";
import { getEnv } from "@/server/env";

const draftSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(200),
  contactEmail: z.string().trim().email().max(320),
  contactPhone: z.string().trim().min(8).max(40),
  website: z.string().trim().url().max(500),
  privacyPolicyUrl: z.string().trim().url().max(500),
  termsUrl: z.string().trim().url().max(500),
  messagingUseCase: z.string().trim().min(30).max(3000),
  optInFlow: z.string().trim().min(30).max(3000),
  sampleMessages: z.array(z.string().trim().min(10).max(1000)).min(2).max(5),
  categories: z.array(z.enum(["TRANSACTIONAL", "MARKETING"])).min(1).max(2),
  allowEmbeddedLinks: z.boolean(),
  businessAddress: z.string().trim().min(4).max(200),
  businessCity: z.string().trim().min(2).max(100),
  businessState: z.string().trim().regex(/^[A-Z]{2}$/),
  businessZip: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
  entityType: z.enum(["PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "GOVERNMENT", "SOLE_PROPRIETOR"]),
  vertical: z.enum(["AGRICULTURE","COMMUNICATION","CONSTRUCTION","EDUCATION","ENERGY","ENTERTAINMENT","FINANCIAL","GAMBLING","GOVERNMENT","HEALTHCARE","HOSPITALITY","HUMAN_RESOURCES","INSURANCE","LEGAL","MANUFACTURING","NGO","POLITICAL","POSTAL","PROFESSIONAL","REAL_ESTATE","RETAIL","TECHNOLOGY","TRANSPORTATION"]),
  ein: z.string().trim().regex(/^(?:\d{2}-?\d{7})?$/),
  messageVolume: z.enum(["10","100","1,000","10,000","100,000","250,000","500,000","750,000","1,000,000","5,000,000","10,000,000+"]),
  optInEvidenceUrl: z.string().trim().url().max(500),
}).strict();

async function managedNumber(workspaceId: string) {
  const [number] = await db.select().from(hostedPhoneNumbers).where(and(
    eq(hostedPhoneNumbers.workspaceId, workspaceId),
    eq(hostedPhoneNumbers.status, "ACTIVE"),
  )).limit(1);
  return number ?? null;
}

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const number = await managedNumber(context.workspace.id);
    const [business] = await db.select().from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, context.workspace.id)).limit(1);
    const [registration] = number ? await db.select().from(smsRegistrations).where(and(
      eq(smsRegistrations.workspaceId, context.workspace.id),
      eq(smsRegistrations.phoneNumberId, number.id),
    )).limit(1) : [];
    const widget = number ? await ensureWebchatWidget(context.workspace.id) : null;
    const hostedOptinUrl = widget ? new URL("/sms/opt-in/" + widget.publicKey, getEnv().BETTER_AUTH_URL).toString() : null;
    return Response.json({
      hostedOptinUrl,
      number: number && { id: number.id, phoneNumber: number.phoneNumber, numberType: number.numberType, messagingReadiness: number.messagingReadiness },
      business: business && { businessName: business.businessName, website: business.websiteUrl, phone: business.phone, address: business.address, city: business.city, state: business.state, postalCode: business.postalCode },
      registration: registration && {
        status: registration.status,
        carrierStatus: registration.carrierStatus,
        rejectionReason: registration.rejectionReason,
        draft: registration.draft,
        submittedAt: registration.submittedAt,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    const input = parseInput(draftSchema, await request.json());
    const number = await managedNumber(context.workspace.id);
    if (!number) throw new AppError("NO_ACTIVE_PHONE_NUMBER", "Activate your managed number before preparing SMS registration.", 409);
    if (number.numberType === "local" && input.entityType !== "SOLE_PROPRIETOR" && !input.ein)
      throw new AppError("EIN_REQUIRED", "Enter your registered business tax ID for 10DLC brand registration.", 422);
    if (number.messagingReadiness === "READY") throw new AppError("SMS_REGISTRATION_APPROVED", "Approved registration details cannot be edited.", 409);
    const [existing] = await db.select().from(smsRegistrations).where(and(
      eq(smsRegistrations.workspaceId, context.workspace.id), eq(smsRegistrations.phoneNumberId, number.id),
    )).limit(1);
    if (existing && ["SUBMITTING", "PENDING"].includes(existing.status))
      throw new AppError("SMS_REGISTRATION_IN_REVIEW", "Carrier review is already in progress.", 409);
    const [registration] = await db.insert(smsRegistrations).values({
      workspaceId: context.workspace.id, phoneNumberId: number.id, numberType: number.numberType,
      status: "DRAFT", draft: input, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: smsRegistrations.phoneNumberId,
      set: { draft: input, status: "DRAFT", rejectionReason: null, carrierCampaignId: null, approvedPolicy: null, updatedAt: new Date() },
    }).returning();
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "NOT_REGISTERED", updatedAt: new Date() })
      .where(and(eq(hostedPhoneNumbers.workspaceId, context.workspace.id), eq(hostedPhoneNumbers.id, number.id)));
    return Response.json({ registration: { status: registration.status, draft: registration.draft } });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    return Response.json(await submitSmsRegistration(context.workspace.id), { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}
