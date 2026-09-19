import { and, eq, inArray } from "drizzle-orm";
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
  legalName: z.string().trim().min(2).max(100),
  contactName: z.string().trim().min(3).max(150).refine((value) => value.split(/\s+/).length >= 2, "Enter a first and last name for the carrier business contact."),
  contactEmail: z.string().trim().email().max(100),
  contactPhone: z.string().trim().regex(/^\+1[2-9]\d{9}$/),
  website: z.string().trim().url().max(100),
  privacyPolicyUrl: z.string().trim().url().max(500),
  termsUrl: z.string().trim().url().max(500),
  messagingUseCase: z.string().trim().min(40).max(500),
  optInFlow: z.string().trim().min(40).max(500),
  sampleMessages: z.array(z.string().trim().min(10).max(400)).min(2).max(5).refine((examples) => examples.join("\n").length <= 1000, "Combined sample messages must not exceed 1,000 characters."),
  categories: z.array(z.enum(["TRANSACTIONAL", "MARKETING"])).min(1).max(2),
  allowEmbeddedLinks: z.boolean(),
  businessAddress: z.string().trim().min(4).max(200),
  businessCity: z.string().trim().min(2).max(100),
  businessState: z.string().trim().regex(/^[A-Z]{2}$/),
  businessZip: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
  entityType: z.enum(["PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "GOVERNMENT", "SOLE_PROPRIETOR"]),
  vertical: z.enum(["AGRICULTURE","COMMUNICATION","CONSTRUCTION","EDUCATION","ENERGY","ENTERTAINMENT","FINANCIAL","GAMBLING","GOVERNMENT","HEALTHCARE","HOSPITALITY","INSURANCE","MANUFACTURING","NGO","REAL_ESTATE","RETAIL","TECHNOLOGY"]),
  ein: z.string().trim().regex(/^(?:\d{2}-?\d{7})?$/),
  messageVolume: z.enum(["10","100","1,000","10,000","100,000","250,000","500,000","750,000","1,000,000","5,000,000","10,000,000+"]),
  optInEvidenceUrl: z.string().trim().url().max(500),
  stockSymbol: z.string().trim().max(10),
  stockExchange: z.enum(["NONE","NASDAQ","NYSE","AMEX","AMX","ASX","B3","BME","BSE","FRA","ICEX","JPX","JSE","KRX","LON","NSE","OMX","SEHK","SSE","STO","SWX","SZSE","TWSE","VSE"]),
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
      canSubmit: context.membership.role === "OWNER",
      hostedOptinUrl,
      number: number && { id: number.id, phoneNumber: number.phoneNumber, numberType: number.numberType, messagingReadiness: number.messagingReadiness },
      business: business && { businessName: business.businessName, website: business.websiteUrl, phone: business.phone, address: business.address, city: business.city, state: business.state, postalCode: business.postalCode },
      registration: registration && {
        status: registration.status,
        soleProprietorOtpAvailable: Boolean(registration.carrierBrandId &&
          (registration.draft as { entityType?: string }).entityType === "SOLE_PROPRIETOR" &&
          ["SUBMITTING", "PENDING"].includes(registration.status)),
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
    if (input.entityType !== "SOLE_PROPRIETOR" && !input.ein)
      throw new AppError("EIN_REQUIRED", "Enter your registered business tax ID for 10DLC brand registration.", 422);
    if (input.entityType === "PUBLIC_PROFIT" && (!input.stockSymbol || input.stockExchange === "NONE"))
      throw new AppError("PUBLIC_BRAND_STOCK_DETAILS_REQUIRED", "Enter the public company stock symbol and exchange.", 422);
    if (number.messagingReadiness === "READY") throw new AppError("SMS_REGISTRATION_APPROVED", "Approved registration details cannot be edited.", 409);
    const [existing] = await db.select().from(smsRegistrations).where(and(
      eq(smsRegistrations.workspaceId, context.workspace.id), eq(smsRegistrations.phoneNumberId, number.id),
    )).limit(1);
    if (existing && ["SUBMITTING", "PENDING"].includes(existing.status))
      throw new AppError("SMS_REGISTRATION_IN_REVIEW", "Carrier review is already in progress.", 409);
    if (existing?.carrierCampaignId) {
      const previous = existing.draft as { categories?: string[] };
      const before = [...(previous.categories ?? [])].sort().join(",");
      const after = [...input.categories].sort().join(",");
      if (before !== after) throw new AppError("SMS_CAMPAIGN_USECASE_LOCKED",
        "The existing carrier campaign cannot change messaging categories. Contact support to register a new campaign.", 409);
    }
    // A submit may start after the read above. Never let a late draft save
    // reset a registration that has already been claimed for carrier review.
    const [registration] = existing
      ? await db.update(smsRegistrations).set({
        draft: input, status: "DRAFT", rejectionReason: null,
        approvedPolicy: null, updatedAt: new Date(),
      }).where(and(
        eq(smsRegistrations.id, existing.id),
        eq(smsRegistrations.workspaceId, context.workspace.id),
        inArray(smsRegistrations.status, ["DRAFT", "REJECTED"]),
      )).returning()
      : await db.insert(smsRegistrations).values({
        workspaceId: context.workspace.id, phoneNumberId: number.id,
        numberType: number.numberType, status: "DRAFT", draft: input, updatedAt: new Date(),
      }).onConflictDoNothing().returning();
    if (!registration) throw new AppError("SMS_REGISTRATION_IN_REVIEW", "Refresh the page; registration has changed.", 409);
    await db.update(hostedPhoneNumbers).set({ messagingReadiness: "NOT_REGISTERED", updatedAt: new Date() })
      .where(and(eq(hostedPhoneNumbers.workspaceId, context.workspace.id), eq(hostedPhoneNumbers.id, number.id)));
    return Response.json({ registration: { status: registration.status, draft: registration.draft } });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "billing.manage");
    return Response.json(await submitSmsRegistration(context.workspace.id), { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}
