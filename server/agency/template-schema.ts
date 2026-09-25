import { z } from "zod";
import {
  aiAgentInputSchema, businessHourSchema, faqInputSchema,
  policyInputSchema, serviceInputSchema,
} from "@/server/domain/onboarding/schemas";
import { automationKeys, parseAutomationConfig, type AutomationKey } from "@/server/automations/schemas";
import { AppError } from "@/server/http/errors";

// Do not add integrations, commercial entitlements, provider secrets, operational
// IDs, contact data or workspace state to this schema. Unknown top-level keys
// are rejected; only explicitly enumerated configuration is retained.
const reusableBusiness = z.object({
  industry: z.string().trim().max(120).nullable().default(null),
  summary: z.string().trim().max(4000).nullable().default(null),
  timezone: z.string().trim().min(1).max(120).default("UTC"),
  hours: z.array(businessHourSchema).max(7).default([]),
}).strict().superRefine((value, ctx) => {
  const days = value.hours.map((hour) => hour.dayOfWeek);
  if (new Set(days).size !== days.length) {
    ctx.addIssue({ code: "custom", path: ["hours"], message: "Business days must not be repeated." });
  }
});

const reusableAgent = aiAgentInputSchema.omit({ completeStep: true }).strict();
const recipeKey = z.enum(automationKeys);
const recipeInput = z.object({
  key: recipeKey,
  config: z.record(z.string(), z.unknown()),
}).strict();

export const agencyTemplateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  business: reusableBusiness,
  agent: reusableAgent,
  services: z.array(serviceInputSchema).max(100).default([]),
  faqs: z.array(faqInputSchema).max(100).default([]),
  policies: z.array(policyInputSchema).max(50).default([]),
  recipes: z.array(recipeInput).max(automationKeys.length).default([]),
}).strict();

export type AgencyTemplateSnapshot = z.infer<typeof agencyTemplateSnapshotSchema>;
export type ReusableRecipe = AgencyTemplateSnapshot["recipes"][number];

// Normalize every recipe against the existing Core recipe validators. Never
// retain a source staff ID, WhatsApp approval or external binding.
export function sanitizeCoreRecipe(key: AutomationKey, rawConfig: unknown): ReusableRecipe {
  if (key === "QUALIFIED_LEAD_ASSIGNMENT" || key === "HUMAN_ESCALATION") {
    const config = parseAutomationConfig(key, rawConfig);
    return { key, config: { ...config, assignedUserId: null } };
  }
  if (key === "APPOINTMENT_CONFIRMATION" || key === "APPOINTMENT_REMINDER") {
    const input = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown> : {};
    const config = parseAutomationConfig(key, {
      ...input, channels: ["SMS"], whatsappTemplateName: null,
    });
    return { key, config };
  }
  const input = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig as Record<string, unknown> : {};
  const config = parseAutomationConfig("MISSED_INQUIRY_RECOVERY", { ...input, channels: ["SMS"] });
  return { key, config };
}

const highConfidenceCredential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk_live_|sk_test_|sk-proj-|Bearer\s+[a-z0-9._-]{16,})/i;

export function parseAgencyTemplateSnapshot(value: unknown): AgencyTemplateSnapshot {
  const parsed = agencyTemplateSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("AGENCY_TEMPLATE_INVALID", "The template contains invalid or unsupported Core configuration.", 400);
  }
  const keys = new Set<AutomationKey>();
  const recipes = parsed.data.recipes.map((recipe) => {
    if (keys.has(recipe.key)) {
      throw new AppError("AGENCY_TEMPLATE_INVALID", "The template contains duplicate Core recipes.", 400);
    }
    keys.add(recipe.key);
    try {
      return sanitizeCoreRecipe(recipe.key, recipe.config);
    } catch {
      throw new AppError("AGENCY_TEMPLATE_INVALID", "A Core recipe has an invalid configuration.", 400);
    }
  });
  const result = { ...parsed.data, recipes };
  if (highConfidenceCredential.test(JSON.stringify(result))) {
    throw new AppError("AGENCY_TEMPLATE_SENSITIVE_CONTENT", "Remove credentials from reusable business content.", 400);
  }
  return result;
}

// Detection is advisory for ordinary content: phone numbers, addresses and
// names might be intentionally reusable. The Agency must explicitly review
// preview content before saving any version.
export function templateReviewWarnings(snapshot: AgencyTemplateSnapshot): string[] {
  const text = [
    snapshot.business.summary ?? "",
    snapshot.agent.advancedInstructions ?? "",
    snapshot.agent.openingMessage ?? "",
    snapshot.agent.escalationMessage ?? "",
    ...snapshot.services.flatMap((service) => [service.name, service.description ?? "", service.priceText ?? ""]),
    ...snapshot.faqs.flatMap((faq) => [faq.question, faq.answer]),
    ...snapshot.policies.flatMap((policy) => [policy.title, policy.content]),
    ...snapshot.recipes.map((recipe) => JSON.stringify(recipe.config)),
  ].join(" ");
  const warnings: string[] = [];
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    warnings.push("Review email addresses in reusable wording.");
  }
  if (/(?:\+?\d[\s().-]?){8,}/.test(text)) {
    warnings.push("Review phone numbers or account numbers in reusable wording.");
  }
  if (/https?:\/\//i.test(text)) {
    warnings.push("Review source-business website links in reusable wording.");
  }
  return warnings;
}
