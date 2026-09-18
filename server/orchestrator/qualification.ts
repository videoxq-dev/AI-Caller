import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiAgents } from "@/db/schema";
import { qualificationConfigSchema, type AIAgentInput } from "@/server/domain/onboarding/schemas";

export type QualificationConfig = AIAgentInput["qualification"];

export function qualificationConfigFromBehaviorSettings(value: unknown): QualificationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return qualificationConfigSchema.parse(undefined);
  }
  const raw = (value as Record<string, unknown>).qualification;
  const parsed = qualificationConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : qualificationConfigSchema.parse(undefined);
}

export async function getQualificationConfig(workspaceId: string): Promise<QualificationConfig> {
  const [agent] = await db.select({ behaviorSettings: aiAgents.behaviorSettings })
    .from(aiAgents)
    .where(eq(aiAgents.workspaceId, workspaceId))
    .limit(1);
  return qualificationConfigFromBehaviorSettings(agent?.behaviorSettings);
}

export function evaluateQualification(
  config: QualificationConfig,
  existing: Record<string, string> | null | undefined,
  answers: Array<{ criterionId: string; answer: string }>,
) {
  const allowed = new Map(config.criteria.map((criterion) => [criterion.id, criterion]));
  const merged: Record<string, string> = { ...(existing ?? {}) };

  for (const item of answers) {
    if (!allowed.has(item.criterionId)) continue;
    const answer = item.answer.trim();
    if (!answer) continue;
    merged[item.criterionId] = answer.slice(0, 2000);
  }

  const answeredCount = config.criteria.filter((criterion) => Boolean(merged[criterion.id]?.trim())).length;
  const required = config.criteria.filter((criterion) => criterion.required);
  const missingRequired = required.filter((criterion) => !merged[criterion.id]?.trim());
  const score = config.criteria.length ? Math.round((answeredCount / config.criteria.length) * 100) : 0;
  const qualified = config.enabled && config.criteria.length > 0 && missingRequired.length === 0;

  return {
    answers: merged,
    score,
    qualified,
    missingRequired: missingRequired.map(({ id, label, question }) => ({ id, label, question })),
  };
}

export function qualificationPrompt(config: QualificationConfig, answers: Record<string, string> | null | undefined) {
  if (!config.enabled || !config.criteria.length) return "Lead qualification: not configured.";

  const current = answers ?? {};
  const lines = config.criteria.map((criterion) => {
    const answer = current[criterion.id]?.trim();
    return `- [${criterion.id}] ${criterion.label}${criterion.required ? " (required)" : ""}: ${criterion.question} Current answer: ${answer || "Not collected"}`;
  });

  return [
    "LEAD QUALIFICATION",
    "Collect these fields naturally rather than reading them as a rigid questionnaire.",
    "Only submit answers the customer explicitly provided. Never infer missing answers.",
    "Use QUALIFY_LEAD when one or more configured answers are available. The server decides when the lead is qualified.",
    ...lines,
  ].join("\n");
}
