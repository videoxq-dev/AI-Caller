import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { getWorkspaceAgent } from "@/server/agent/service";
import {
  aiAgents,
  businessHours,
  businessProfiles,
  faqs,
  policies,
  services,
  setupProgress,
} from "@/db/schema";
import type { AIAgentInput, BusinessProfileInput, FAQInput, PolicyInput, ServiceInput } from "./schemas";

function cleanNullable(value: string | null | undefined) {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

export async function getBusinessSetup(workspaceId: string) {
  const [profile] = await db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
  const hours = await db
    .select()
    .from(businessHours)
    .where(eq(businessHours.workspaceId, workspaceId))
    .orderBy(asc(businessHours.dayOfWeek));

  return { profile: profile ?? null, hours };
}

export async function saveBusinessSetup(workspaceId: string, input: BusinessProfileInput) {
  const now = new Date();
  const [profile] = await db
    .insert(businessProfiles)
    .values({
      workspaceId,
      businessName: input.businessName,
      industry: cleanNullable(input.industry),
      websiteUrl: cleanNullable(input.websiteUrl),
      phone: cleanNullable(input.phone),
      address: cleanNullable(input.address),
      city: cleanNullable(input.city),
      state: cleanNullable(input.state),
      postalCode: cleanNullable(input.postalCode),
      country: cleanNullable(input.country),
      serviceRadius: cleanNullable(input.serviceRadius),
      timezone: input.timezone,
      summary: cleanNullable(input.summary),
      setupCompletedAt: input.completeStep ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: {
        businessName: input.businessName,
        industry: cleanNullable(input.industry),
        websiteUrl: cleanNullable(input.websiteUrl),
        phone: cleanNullable(input.phone),
        address: cleanNullable(input.address),
        city: cleanNullable(input.city),
        state: cleanNullable(input.state),
        postalCode: cleanNullable(input.postalCode),
        country: cleanNullable(input.country),
        serviceRadius: cleanNullable(input.serviceRadius),
        timezone: input.timezone,
        summary: cleanNullable(input.summary),
        ...(input.completeStep ? { setupCompletedAt: now } : {}),
        updatedAt: now,
      },
    })
    .returning();

  if (input.hours) {
    await db.transaction(async (tx) => {
      for (const hour of input.hours ?? []) {
        await tx
          .insert(businessHours)
          .values({
            workspaceId,
            dayOfWeek: hour.dayOfWeek,
            enabled: hour.enabled,
            openTime: hour.enabled ? cleanNullable(hour.openTime) : null,
            closeTime: hour.enabled ? cleanNullable(hour.closeTime) : null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [businessHours.workspaceId, businessHours.dayOfWeek],
            set: {
              enabled: hour.enabled,
              openTime: hour.enabled ? cleanNullable(hour.openTime) : null,
              closeTime: hour.enabled ? cleanNullable(hour.closeTime) : null,
              updatedAt: now,
            },
          });
      }
    });
  }

  if (input.completeStep) await markSetupStep(workspaceId, "business", now);
  return profile;
}

export async function getAgentSetup(workspaceId: string) {
  const agent = await getWorkspaceAgent(workspaceId);
  const serviceRows = await db.select().from(services).where(eq(services.workspaceId, workspaceId)).orderBy(asc(services.createdAt));
  const faqRows = await db.select().from(faqs).where(eq(faqs.workspaceId, workspaceId)).orderBy(asc(faqs.createdAt));
  const policyRows = await db.select().from(policies).where(eq(policies.workspaceId, workspaceId)).orderBy(asc(policies.createdAt));
  return { agent, services: serviceRows, faqs: faqRows, policies: policyRows };
}

export async function saveAgentSetup(workspaceId: string, input: AIAgentInput) {
  const now = new Date();
  const behaviorSettings = {
    guardrails: input.guardrails,
    voice: input.voice,
    qualification: input.qualification,
  };
  const [agent] = await db
    .insert(aiAgents)
    .values({
      workspaceId,
      name: input.name,
      tone: input.tone,
      primaryGoal: input.primaryGoal,
      whenUnsure: input.whenUnsure,
      advancedInstructions: cleanNullable(input.advancedInstructions),
      escalationMessage: cleanNullable(input.escalationMessage),
      openingMessage: cleanNullable(input.openingMessage),
      behaviorSettings,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: aiAgents.workspaceId,
      set: {
        name: input.name,
        tone: input.tone,
        primaryGoal: input.primaryGoal,
        whenUnsure: input.whenUnsure,
        advancedInstructions: cleanNullable(input.advancedInstructions),
        escalationMessage: cleanNullable(input.escalationMessage),
        openingMessage: cleanNullable(input.openingMessage),
        // Merge against the current row atomically so concurrently saved
        // capability permissions are never overwritten by an agent form save.
        behaviorSettings: sql`coalesce(${aiAgents.behaviorSettings}, '{}'::jsonb) || ${JSON.stringify(behaviorSettings)}::jsonb`,
        updatedAt: now,
      },
    })
    .returning();

  if (input.completeStep) await markSetupStep(workspaceId, "ai", now);
  return agent;
}

export async function markSetupStep(
  workspaceId: string,
  step: "business" | "ai" | "communication" | "calendar" | "test" | "live",
  completedAt = new Date(),
) {
  const column = {
    business: "businessCompletedAt",
    ai: "aiCompletedAt",
    communication: "communicationCompletedAt",
    calendar: "calendarCompletedAt",
    test: "testCompletedAt",
    live: "liveCompletedAt",
  }[step] as keyof typeof setupProgress.$inferInsert;

  const update = { [column]: completedAt, updatedAt: completedAt } as Partial<typeof setupProgress.$inferInsert>;
  await db
    .insert(setupProgress)
    .values({ workspaceId, ...update })
    .onConflictDoUpdate({ target: setupProgress.workspaceId, set: update });
}

export async function getSetupStatus(workspaceId: string) {
  const [[progress], agent] = await Promise.all([
    db.select().from(setupProgress).where(eq(setupProgress.workspaceId, workspaceId)).limit(1),
    getWorkspaceAgent(workspaceId),
  ]);
  // Agents already activated before liveCompletedAt was written are also
  // finished with onboarding, including accounts that later paused the agent.
  const wentLive = Boolean(progress?.liveCompletedAt) || agent?.status === "ACTIVE" || agent?.status === "PAUSED";
  const completed = [
    Boolean(progress?.businessCompletedAt),
    Boolean(progress?.aiCompletedAt),
    Boolean(progress?.communicationCompletedAt),
    Boolean(progress?.calendarCompletedAt),
    Boolean(progress?.testCompletedAt),
    wentLive,
  ];
  const completedCount = completed.filter(Boolean).length;
  return {
    completedCount,
    percent: Math.round((completedCount / 6) * 100),
    steps: {
      business: completed[0],
      ai: completed[1],
      communication: completed[2],
      calendar: completed[3],
      test: completed[4],
      live: completed[5],
    },
  };
}

export async function createService(workspaceId: string, input: ServiceInput) {
  const [row] = await db.insert(services).values({ workspaceId, ...input }).returning();
  return row;
}

export async function updateService(workspaceId: string, id: string, input: Partial<ServiceInput>) {
  const [row] = await db
    .update(services)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(services.workspaceId, workspaceId), eq(services.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteService(workspaceId: string, id: string) {
  const [row] = await db.delete(services).where(and(eq(services.workspaceId, workspaceId), eq(services.id, id))).returning();
  return row ?? null;
}

export async function createFAQ(workspaceId: string, input: FAQInput) {
  const [row] = await db.insert(faqs).values({ workspaceId, ...input }).returning();
  return row;
}

export async function updateFAQ(workspaceId: string, id: string, input: Partial<FAQInput>) {
  const [row] = await db
    .update(faqs)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(faqs.workspaceId, workspaceId), eq(faqs.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteFAQ(workspaceId: string, id: string) {
  const [row] = await db.delete(faqs).where(and(eq(faqs.workspaceId, workspaceId), eq(faqs.id, id))).returning();
  return row ?? null;
}

export async function createPolicy(workspaceId: string, input: PolicyInput) {
  const [row] = await db.insert(policies).values({ workspaceId, ...input }).returning();
  return row;
}

export async function updatePolicy(workspaceId: string, id: string, input: Partial<PolicyInput>) {
  const [row] = await db
    .update(policies)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(policies.workspaceId, workspaceId), eq(policies.id, id)))
    .returning();
  return row ?? null;
}

export async function deletePolicy(workspaceId: string, id: string) {
  const [row] = await db.delete(policies).where(and(eq(policies.workspaceId, workspaceId), eq(policies.id, id))).returning();
  return row ?? null;
}
