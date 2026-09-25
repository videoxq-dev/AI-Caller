import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agencyWorkspaceTemplates, agencyWorkspaceTemplateVersions,
  aiAgents, automationSettings, businessHours, businessProfiles, creditWallets,
  faqs, licenses, policies, services, workspaceCommercialOwners,
} from "@/db/schema";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { createWorkspaceForUser } from "@/server/auth/workspace-repository";
import { AppError } from "@/server/http/errors";
import { parseAgencyTemplateSnapshot, type AgencyTemplateSnapshot } from "./template-schema";
import { getAgencyTemplateVersion, requireAgencyTemplatePurchaser } from "./templates";

function withClientName(text: string | null | undefined, name: string): string | null {
  return text == null ? null : text.replace(/\{\{business_name\}\}/g, name);
}

// New clients cannot inherit a source business's operational readiness. A
// configured but DRAFT agent must be deliberately checked and activated.
const initialCapabilities = {
  ...defaultAgentCapabilities,
  CHECK_AVAILABILITY: false,
  BOOK_APPOINTMENT: false,
  RESCHEDULE_APPOINTMENT: false,
  CANCEL_APPOINTMENT: false,
  RECORD_SMS_CONSENT: false,
  SEND_SMS: false,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyCoreTemplate(tx: Tx, workspaceId: string, name: string, snapshot: AgencyTemplateSnapshot) {
  await tx.insert(businessProfiles).values({
    workspaceId,
    businessName: name,
    industry: snapshot.business.industry,
    summary: withClientName(snapshot.business.summary, name),
    timezone: snapshot.business.timezone,
    // Never inherit website, phone, address or source onboarding completion.
    setupCompletedAt: null,
  });
  if (snapshot.business.hours.length) {
    await tx.insert(businessHours).values(snapshot.business.hours.map((hour) => ({
      workspaceId, dayOfWeek: hour.dayOfWeek, enabled: hour.enabled,
      openTime: hour.enabled ? (hour.openTime ?? null) : null,
      closeTime: hour.enabled ? (hour.closeTime ?? null) : null,
    })));
  }
  const agent = snapshot.agent;
  await tx.insert(aiAgents).values({
    workspaceId, status: "DRAFT",
    name: withClientName(agent.name, name) ?? agent.name,
    tone: withClientName(agent.tone, name) ?? agent.tone,
    primaryGoal: withClientName(agent.primaryGoal, name) ?? agent.primaryGoal,
    whenUnsure: withClientName(agent.whenUnsure, name) ?? agent.whenUnsure,
    advancedInstructions: withClientName(agent.advancedInstructions, name),
    openingMessage: withClientName(agent.openingMessage, name),
    escalationMessage: withClientName(agent.escalationMessage, name),
    behaviorSettings: {
      guardrails: agent.guardrails.map((rule) => withClientName(rule, name) ?? rule),
      voice: agent.voice,
      qualification: {
        ...agent.qualification,
        criteria: agent.qualification.criteria.map((criterion) => ({
          ...criterion, question: withClientName(criterion.question, name) ?? criterion.question,
          label: withClientName(criterion.label, name) ?? criterion.label,
        })),
      },
      capabilities: initialCapabilities,
    },
  });
  if (snapshot.services.length) {
    await tx.insert(services).values(snapshot.services.map((item) => ({
      workspaceId,
      name: withClientName(item.name, name) ?? item.name,
      description: withClientName(item.description, name),
      priceText: withClientName(item.priceText, name),
      durationMinutes: item.durationMinutes,
      active: item.active,
    })));
  }
  if (snapshot.faqs.length) {
    await tx.insert(faqs).values(snapshot.faqs.map((item) => ({
      workspaceId,
      question: withClientName(item.question, name) ?? item.question,
      answer: withClientName(item.answer, name) ?? item.answer,
      active: item.active,
    })));
  }
  if (snapshot.policies.length) {
    await tx.insert(policies).values(snapshot.policies.map((item) => ({
      workspaceId,
      type: item.type,
      title: withClientName(item.title, name) ?? item.title,
      content: withClientName(item.content, name) ?? item.content,
    })));
  }
  if (snapshot.recipes.length) {
    await tx.insert(automationSettings).values(snapshot.recipes.map((recipe) => {
      const config = { ...recipe.config };
      if (typeof config.message === "string") {
        config.message = withClientName(config.message, name);
      }
      // Never copy the source enabled flag; no scheduled message can begin
      // before the destination's consent and channel readiness checks.
      return { workspaceId, key: recipe.key, enabled: false, config };
    }));
  }
  await tx.insert(creditWallets).values({ workspaceId, balance: 0 });
}

export async function createWorkspaceFromAgencyTemplate(input: {
  purchaserUserId: string;
  name: string;
  templateId: string;
  version: number;
  idempotencyKey: string;
}) {
  const template = await getAgencyTemplateVersion(input.purchaserUserId, input.templateId, input.version);
  await requireAgencyTemplatePurchaser(input.purchaserUserId);
  if (template.status !== "ACTIVE") {
    throw new AppError("AGENCY_TEMPLATE_ARCHIVED", "Archived templates cannot provision new clients.", 409);
  }

  const workspaceName = input.name.trim();
  if (workspaceName.length < 2 || workspaceName.length > 120) {
    throw new AppError("WORKSPACE_NAME_INVALID", "Business name must be 2–120 characters.", 400);
  }

  return createWorkspaceForUser(input.purchaserUserId, workspaceName, {
    templateId: template.templateId,
    templateVersionId: template.templateVersionId,
    version: template.version,
    idempotencyKey: input.idempotencyKey,
    apply: async (tx, workspaceId) => {
      // Repeat checks inside the quota-locked transaction. In particular a
      // refunded Agency entitlement must not pass based on an earlier read.
      const [agency] = await tx.select({ id: licenses.id }).from(licenses).where(and(
        eq(licenses.purchaserUserId, input.purchaserUserId),
        eq(licenses.status, "ACTIVE"),
        sql`${licenses.productCode} in ('AGENCY_50', 'AGENCY_100')`,
      )).limit(1);
      if (!agency) throw new AppError("AGENCY_REQUIRED", "An active Agency purchase is required.", 403);
      const [primary] = await tx.select({ workspaceId: workspaceCommercialOwners.workspaceId })
        .from(workspaceCommercialOwners).where(and(
          eq(workspaceCommercialOwners.purchaserUserId, input.purchaserUserId),
          eq(workspaceCommercialOwners.kind, "PRIMARY"),
        )).limit(1);
      if (!primary) {
        throw new AppError("AGENCY_PRIMARY_WORKSPACE_REQUIRED", "Set up the Agency's original business first.", 409);
      }
      const [exact] = await tx.select({ snapshot: agencyWorkspaceTemplateVersions.snapshot })
        .from(agencyWorkspaceTemplateVersions)
        .innerJoin(agencyWorkspaceTemplates, eq(
          agencyWorkspaceTemplates.id, agencyWorkspaceTemplateVersions.templateId,
        )).where(and(
          eq(agencyWorkspaceTemplates.purchaserUserId, input.purchaserUserId),
          eq(agencyWorkspaceTemplates.id, template.templateId),
          eq(agencyWorkspaceTemplates.status, "ACTIVE"),
          eq(agencyWorkspaceTemplateVersions.id, template.templateVersionId),
          eq(agencyWorkspaceTemplateVersions.version, template.version),
        )).limit(1);
      if (!exact) {
        throw new AppError("AGENCY_TEMPLATE_NOT_FOUND", "Template version is no longer available.", 404);
      }
      await applyCoreTemplate(tx, workspaceId, workspaceName, parseAgencyTemplateSnapshot(exact.snapshot));
    },
  });
}
