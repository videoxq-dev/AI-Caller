import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agencyWorkspaceTemplates, agencyWorkspaceTemplateVersions, licenses,
} from "@/db/schema";
import { requireAgencyManagedWorkspace } from "@/server/agency/access";
import { getAgentSetup, getBusinessSetup } from "@/server/domain/onboarding/repository";
import { listAutomationSettings } from "@/server/automations/repository";
import { AppError } from "@/server/http/errors";
import {
  parseAgencyTemplateSnapshot, sanitizeCoreRecipe, templateReviewWarnings,
  type AgencyTemplateSnapshot,
} from "./template-schema";

async function requireAgencyTemplatePurchaser(purchaserUserId: string) {
  const [agency] = await db.select({ id: licenses.id }).from(licenses).where(and(
    eq(licenses.purchaserUserId, purchaserUserId),
    eq(licenses.status, "ACTIVE"),
    sql`${licenses.productCode} in ('AGENCY_50', 'AGENCY_100')`,
  )).limit(1);
  if (!agency) throw new AppError("AGENCY_REQUIRED", "An active Agency package is required.", 403);
}

function requireReview(reviewed: boolean) {
  if (reviewed !== true) {
    throw new AppError(
      "AGENCY_TEMPLATE_REVIEW_REQUIRED",
      "Review reusable content for client names, addresses, links and other private details before saving.",
      400,
    );
  }
}

function templateName(name: string) {
  const value = name.trim();
  if (value.length < 2 || value.length > 120) {
    throw new AppError("AGENCY_TEMPLATE_NAME_INVALID", "A template name must be between 2 and 120 characters.", 400);
  }
  return value;
}

function templateDescription(description?: string | null) {
  const value = description?.trim() || null;
  if (value && value.length > 400) {
    throw new AppError("AGENCY_TEMPLATE_DESCRIPTION_INVALID", "Template description is too long.", 400);
  }
  return value;
}

function snapshotToRecord(snapshot: AgencyTemplateSnapshot): Record<string, unknown> {
  if (JSON.stringify(snapshot).length > 250_000) {
    throw new AppError("AGENCY_TEMPLATE_TOO_LARGE", "The reusable template is too large.", 400);
  }
  return snapshot as unknown as Record<string, unknown>;
}

/** Extraction never publishes. The Agency must review the preview and submit the curated payload. */
export async function buildAgencyTemplatePreview(purchaserUserId: string, sourceWorkspaceId: string) {
  await requireAgencyManagedWorkspace(purchaserUserId, sourceWorkspaceId);
  const [business, setup, automation] = await Promise.all([
    getBusinessSetup(sourceWorkspaceId),
    getAgentSetup(sourceWorkspaceId),
    listAutomationSettings(sourceWorkspaceId),
  ]);
  if (!setup.agent) {
    throw new AppError(
      "AGENCY_TEMPLATE_SOURCE_AGENT_REQUIRED",
      "Configure the source business AI Agent before creating a reusable template.",
      409,
    );
  }
  const agent = setup.agent;
  const behavior = agent.behaviorSettings ?? {};
  const snapshot = parseAgencyTemplateSnapshot({
    schemaVersion: 1,
    business: {
      industry: business.profile?.industry ?? null,
      summary: business.profile?.summary ?? null,
      timezone: business.profile?.timezone ?? "UTC",
      hours: business.hours.map((hour) => ({
        dayOfWeek: hour.dayOfWeek, enabled: hour.enabled,
        openTime: hour.openTime, closeTime: hour.closeTime,
      })),
    },
    agent: {
      name: agent.name, tone: agent.tone, primaryGoal: agent.primaryGoal,
      whenUnsure: agent.whenUnsure,
      advancedInstructions: agent.advancedInstructions,
      openingMessage: agent.openingMessage,
      escalationMessage: agent.escalationMessage,
      guardrails: behavior.guardrails ?? [],
      voice: behavior.voice,
      qualification: behavior.qualification,
    },
    services: setup.services.map((service) => ({
      name: service.name, description: service.description,
      priceText: service.priceText, durationMinutes: service.durationMinutes,
      active: service.active,
    })),
    faqs: setup.faqs.map((faq) => ({
      question: faq.question, answer: faq.answer, active: faq.active,
    })),
    policies: setup.policies.map((policy) => ({
      type: policy.type, title: policy.title, content: policy.content,
    })),
    recipes: automation.map((recipe) => sanitizeCoreRecipe(recipe.key, recipe.config)),
  });
  return {
    snapshot,
    warnings: templateReviewWarnings(snapshot),
    reviewRequired: true as const,
  };
}

export async function listAgencyTemplates(purchaserUserId: string) {
  await requireAgencyTemplatePurchaser(purchaserUserId);
  return db.select({
    id: agencyWorkspaceTemplates.id,
    name: agencyWorkspaceTemplates.name,
    description: agencyWorkspaceTemplates.description,
    currentVersion: agencyWorkspaceTemplates.currentVersion,
    createdAt: agencyWorkspaceTemplates.createdAt,
    updatedAt: agencyWorkspaceTemplates.updatedAt,
  }).from(agencyWorkspaceTemplates).where(and(
    eq(agencyWorkspaceTemplates.purchaserUserId, purchaserUserId),
    eq(agencyWorkspaceTemplates.status, "ACTIVE"),
  )).orderBy(desc(agencyWorkspaceTemplates.updatedAt), asc(agencyWorkspaceTemplates.name)).limit(200);
}

export async function getAgencyTemplateVersion(
  purchaserUserId: string, templateId: string, version?: number,
) {
  const [row] = await db.select({
    templateId: agencyWorkspaceTemplates.id,
    name: agencyWorkspaceTemplates.name,
    description: agencyWorkspaceTemplates.description,
    status: agencyWorkspaceTemplates.status,
    currentVersion: agencyWorkspaceTemplates.currentVersion,
    version: agencyWorkspaceTemplateVersions.version,
    snapshot: agencyWorkspaceTemplateVersions.snapshot,
  }).from(agencyWorkspaceTemplates)
    .innerJoin(agencyWorkspaceTemplateVersions, eq(
      agencyWorkspaceTemplateVersions.templateId, agencyWorkspaceTemplates.id,
    ))
    .where(and(
      eq(agencyWorkspaceTemplates.id, templateId),
      eq(agencyWorkspaceTemplates.purchaserUserId, purchaserUserId),
      version ? eq(agencyWorkspaceTemplateVersions.version, version) : eq(
        agencyWorkspaceTemplateVersions.version, agencyWorkspaceTemplates.currentVersion,
      ),
    )).limit(1);
  if (!row) throw new AppError("AGENCY_TEMPLATE_NOT_FOUND", "Template version not found.", 404);
  return { ...row, snapshot: parseAgencyTemplateSnapshot(row.snapshot) };
}

export async function createAgencyTemplate(input: {
  purchaserUserId: string;
  name: string;
  description?: string | null;
  reviewed: boolean;
  snapshot: unknown;
}) {
  requireReview(input.reviewed);
  const name = templateName(input.name);
  const description = templateDescription(input.description);
  const snapshot = snapshotToRecord(parseAgencyTemplateSnapshot(input.snapshot));
  await requireAgencyTemplatePurchaser(input.purchaserUserId);
  return db.transaction(async (tx) => {
    const [template] = await tx.insert(agencyWorkspaceTemplates).values({
      purchaserUserId: input.purchaserUserId, name, description,
    }).returning();
    await tx.insert(agencyWorkspaceTemplateVersions).values({
      templateId: template.id, version: 1, snapshot,
    });
    return template;
  });
}

export async function publishAgencyTemplateVersion(input: {
  purchaserUserId: string;
  templateId: string;
  expectedVersion: number;
  name?: string;
  description?: string | null;
  reviewed: boolean;
  snapshot: unknown;
}) {
  requireReview(input.reviewed);
  const snapshot = snapshotToRecord(parseAgencyTemplateSnapshot(input.snapshot));
  const name = input.name === undefined ? undefined : templateName(input.name);
  const description = input.description === undefined ? undefined : templateDescription(input.description);
  await requireAgencyTemplatePurchaser(input.purchaserUserId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agency-template:${input.templateId}`}))`);
    const [current] = await tx.select().from(agencyWorkspaceTemplates).where(and(
      eq(agencyWorkspaceTemplates.id, input.templateId),
      eq(agencyWorkspaceTemplates.purchaserUserId, input.purchaserUserId),
    )).limit(1);
    if (!current) throw new AppError("AGENCY_TEMPLATE_NOT_FOUND", "Template not found.", 404);
    if (current.status !== "ACTIVE") {
      throw new AppError("AGENCY_TEMPLATE_ARCHIVED", "Archived templates cannot be edited.", 409);
    }
    if (current.currentVersion !== input.expectedVersion) {
      throw new AppError("AGENCY_TEMPLATE_VERSION_CONFLICT", "This template changed. Reload before saving.", 409);
    }
    const version = current.currentVersion + 1;
    await tx.insert(agencyWorkspaceTemplateVersions).values({
      templateId: current.id, version, snapshot,
    });
    const [updated] = await tx.update(agencyWorkspaceTemplates).set({
      currentVersion: version,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      updatedAt: new Date(),
    }).where(eq(agencyWorkspaceTemplates.id, current.id)).returning();
    return updated;
  });
}

export async function archiveAgencyTemplate(purchaserUserId: string, templateId: string) {
  await requireAgencyTemplatePurchaser(purchaserUserId);
  const [archived] = await db.update(agencyWorkspaceTemplates).set({
    status: "ARCHIVED", updatedAt: new Date(),
  }).where(and(
    eq(agencyWorkspaceTemplates.id, templateId),
    eq(agencyWorkspaceTemplates.purchaserUserId, purchaserUserId),
  )).returning();
  if (!archived) throw new AppError("AGENCY_TEMPLATE_NOT_FOUND", "Template not found.", 404);
  return archived;
}
