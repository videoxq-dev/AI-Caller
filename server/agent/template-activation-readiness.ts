import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agencyTemplateActivationReviews, agencyWorkspaceTemplateApplications,
  aiAgents, businessHours, businessProfiles, creditWallets, faqs,
  memberships, policies, services, setupProgress, workspaces,
} from "@/db/schema";
import { AppError } from "@/server/http/errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MissingRequirement = {
  code: "WORKSPACE_ACTIVE" | "BUSINESS_SETUP" | "AGENT_SETUP" | "AGENCY_CREDITS" | "MANUAL_REVIEW";
  label: string;
};
export type TemplateActivationReadiness = {
  templated: boolean;
  ready: boolean;
  balance: number;
  reviewedAt: Date | null;
  missing: MissingRequirement[];
};

async function configurationHash(tx: Tx, workspaceId: string) {
  const [profile] = await tx.select({
    businessName: businessProfiles.businessName,
    industry: businessProfiles.industry,
    websiteUrl: businessProfiles.websiteUrl,
    phone: businessProfiles.phone,
    address: businessProfiles.address,
    city: businessProfiles.city,
    state: businessProfiles.state,
    postalCode: businessProfiles.postalCode,
    country: businessProfiles.country,
    serviceRadius: businessProfiles.serviceRadius,
    timezone: businessProfiles.timezone,
    summary: businessProfiles.summary,
  }).from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
  const [agent] = await tx.select({
    name: aiAgents.name, tone: aiAgents.tone,
    primaryGoal: aiAgents.primaryGoal, whenUnsure: aiAgents.whenUnsure,
    advancedInstructions: aiAgents.advancedInstructions,
    openingMessage: aiAgents.openingMessage,
    escalationMessage: aiAgents.escalationMessage,
    behaviorSettings: aiAgents.behaviorSettings,
  }).from(aiAgents).where(eq(aiAgents.workspaceId, workspaceId)).limit(1);
  if (!profile || !agent) return null;
  const hours = await tx.select({
    dayOfWeek: businessHours.dayOfWeek,
    enabled: businessHours.enabled,
    openTime: businessHours.openTime,
    closeTime: businessHours.closeTime,
  }).from(businessHours).where(eq(businessHours.workspaceId, workspaceId))
    .orderBy(asc(businessHours.dayOfWeek));
  const catalogue = await tx.select({
    name: services.name, description: services.description,
    priceText: services.priceText, durationMinutes: services.durationMinutes,
    active: services.active,
  }).from(services).where(eq(services.workspaceId, workspaceId))
    .orderBy(asc(services.id));
  const answers = await tx.select({
    question: faqs.question, answer: faqs.answer, active: faqs.active,
  }).from(faqs).where(eq(faqs.workspaceId, workspaceId))
    .orderBy(asc(faqs.id));
  const rules = await tx.select({
    type: policies.type, title: policies.title, content: policies.content,
  }).from(policies).where(eq(policies.workspaceId, workspaceId))
    .orderBy(asc(policies.id));
  return createHash("sha256").update(JSON.stringify({
    profile, agent, hours, catalogue, answers, rules,
  })).digest("hex");
}

async function readInTx(tx: Tx, workspaceId: string): Promise<TemplateActivationReadiness> {
  const [application] = await tx.select({ workspaceId: agencyWorkspaceTemplateApplications.workspaceId })
    .from(agencyWorkspaceTemplateApplications)
    .where(eq(agencyWorkspaceTemplateApplications.workspaceId, workspaceId)).limit(1);
  if (!application) {
    return { templated: false, ready: true, balance: 0, reviewedAt: null, missing: [] };
  }
  const [workspace] = await tx.select({ status: workspaces.status }).from(workspaces)
    .where(eq(workspaces.id, workspaceId)).limit(1);
  const [profile] = await tx.select({ complete: businessProfiles.setupCompletedAt })
    .from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
  const [agent] = await tx.select({ id: aiAgents.id }).from(aiAgents)
    .where(eq(aiAgents.workspaceId, workspaceId)).limit(1);
  const [progress] = await tx.select({
    business: setupProgress.businessCompletedAt,
    agent: setupProgress.aiCompletedAt,
  }).from(setupProgress).where(eq(setupProgress.workspaceId, workspaceId)).limit(1);
  const [wallet] = await tx.select({ balance: creditWallets.balance }).from(creditWallets)
    .where(eq(creditWallets.workspaceId, workspaceId)).limit(1);
  const [review] = await tx.select({
    configurationHash: agencyTemplateActivationReviews.configurationHash,
    reviewedAt: agencyTemplateActivationReviews.reviewedAt,
  }).from(agencyTemplateActivationReviews)
    .where(eq(agencyTemplateActivationReviews.workspaceId, workspaceId)).limit(1);
  const balance = wallet?.balance ?? 0;
  const missing: MissingRequirement[] = [];
  if (workspace?.status !== "ACTIVE") {
    missing.push({ code: "WORKSPACE_ACTIVE", label: "Restore the client's workspace to active status." });
  }
  if (!profile?.complete || !progress?.business) {
    missing.push({ code: "BUSINESS_SETUP", label: "Review and complete this client's own business details." });
  }
  if (!agent || !progress?.agent) {
    missing.push({ code: "AGENT_SETUP", label: "Review and complete this client's AI Agent configuration." });
  }
  if (balance <= 0) {
    missing.push({ code: "AGENCY_CREDITS", label: "Ask the Agency to allocate credits to this client's wallet." });
  }
  const currentHash = await configurationHash(tx, workspaceId);
  if (!review || !currentHash || currentHash !== review.configurationHash) {
    missing.push({
      code: "MANUAL_REVIEW",
      label: "Confirm you manually checked the client's configuration and intended channels. This is not a carrier-delivery test.",
    });
  }
  return {
    templated: true,
    ready: missing.length === 0,
    balance,
    reviewedAt: review?.reviewedAt ?? null,
    missing,
  };
}

export async function getTemplateClientActivationReadiness(workspaceId: string) {
  return db.transaction((tx) => readInTx(tx, workspaceId));
}

export async function confirmTemplateClientManualReview(workspaceId: string, reviewerUserId: string) {
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, reviewerUserId))).limit(1);
    if (!member || member.role === "STAFF") {
      throw new AppError("FORBIDDEN", "Only an authorized workspace owner or admin can confirm readiness.", 403);
    }
    const readiness = await readInTx(tx, workspaceId);
    if (!readiness.templated) {
      throw new AppError("TEMPLATE_REVIEW_NOT_REQUIRED", "This workspace was not created from an Agency template.", 409);
    }
    const blockers = readiness.missing.filter((item) => item.code !== "MANUAL_REVIEW");
    if (blockers.length) {
      throw new AppError("AGENCY_CLIENT_NOT_READY",
        "Complete the client setup before confirming manual review.", 409, blockers);
    }
    const hash = await configurationHash(tx, workspaceId);
    if (!hash) throw new AppError("AGENCY_CLIENT_NOT_READY", "Complete the AI Agent and business setup first.", 409);
    await tx.insert(agencyTemplateActivationReviews).values({
      workspaceId, reviewerUserId, configurationHash: hash,
    }).onConflictDoUpdate({
      target: agencyTemplateActivationReviews.workspaceId,
      set: { reviewerUserId, configurationHash: hash, reviewedAt: new Date() },
    });
    return readInTx(tx, workspaceId);
  });
}

export async function assertTemplateClientActivationReadyInTx(tx: Tx, workspaceId: string) {
  const readiness = await readInTx(tx, workspaceId);
  if (readiness.templated && !readiness.ready) {
    throw new AppError(
      "AGENCY_CLIENT_NOT_READY",
      "Complete the cloned client's own setup and manual review before activating the AI Agent.",
      409,
      readiness.missing,
    );
  }
}
