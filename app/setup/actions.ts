"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { getBusinessSetup, saveAgentSetup, saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { aiAgentInputSchema, businessProfileInputSchema } from "@/server/domain/onboarding/schemas";

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();

export async function saveBusinessSetupAction(formData: FormData) {
  const context = await resolveWorkspaceContext(await headers());
  requireWorkspacePermission(context.membership.role, "integration.manage");
  const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    enabled: formData.get(`hours.${dayOfWeek}.enabled`) === "on",
    openTime: field(formData, `hours.${dayOfWeek}.openTime`) || null,
    closeTime: field(formData, `hours.${dayOfWeek}.closeTime`) || null,
  }));
  const completeStep = field(formData, "intent") === "continue";
  const input = businessProfileInputSchema.parse({
    businessName: field(formData, "businessName"),
    industry: field(formData, "industry") || null,
    websiteUrl: field(formData, "website") || null,
    phone: field(formData, "phone") || null,
    address: field(formData, "address") || null,
    city: field(formData, "city") || null,
    state: field(formData, "state") || null,
    postalCode: field(formData, "zip") || null,
    country: field(formData, "country") || null,
    serviceRadius: field(formData, "radius") || null,
    timezone: field(formData, "timezone") || "UTC",
    hours,
    completeStep,
  });
  await saveBusinessSetup(context.workspace.id, input);
  redirect(completeStep ? "/setup/ai" : "/setup/business?saved=1");
}

export async function saveAISetupAction(formData: FormData) {
  const context = await resolveWorkspaceContext(await headers());
  requireWorkspacePermission(context.membership.role, "integration.manage");
  const completeStep = field(formData, "intent") === "continue";
  const guardrails = formData.getAll("guardrails").map((value) => String(value));
  const qualificationConfig = (() => {
    const raw = field(formData, "qualificationConfig");
    if (!raw) return { enabled: false, criteria: [] };
    try { return JSON.parse(raw) as unknown; } catch { return { enabled: false, criteria: [] }; }
  })();
  const input = aiAgentInputSchema.parse({
    name: field(formData, "assistantName"),
    primaryGoal: field(formData, "primaryGoal"),
    tone: field(formData, "tone"),
    whenUnsure: field(formData, "fallback"),
    escalationMessage: field(formData, "escalationInstructions") || null,
    advancedInstructions: null,
    openingMessage: null,
    guardrails,
    voice: {
      profileKey: field(formData, "voiceProfile") || "ava-us-1",
      language: field(formData, "voiceLanguage") || "en-US",
      speakingRate: Number(field(formData, "voiceSpeed") || "1"),
      recordingPolicy: field(formData, "recordingPolicy") || "ANNOUNCE",
      afterHoursEnabled: field(formData, "afterHoursEnabled") !== "off",
    },
    qualification: qualificationConfig,
    completeStep,
  });
  await saveAgentSetup(context.workspace.id, input);

  const business = await getBusinessSetup(context.workspace.id);
  if (business.profile) {
    await saveBusinessSetup(context.workspace.id, {
      businessName: business.profile.businessName,
      industry: business.profile.industry,
      websiteUrl: business.profile.websiteUrl,
      phone: business.profile.phone,
      address: business.profile.address,
      city: business.profile.city,
      state: business.profile.state,
      postalCode: business.profile.postalCode,
      country: business.profile.country,
      serviceRadius: business.profile.serviceRadius,
      timezone: business.profile.timezone,
      summary: field(formData, "summary") || null,
      completeStep: false,
    });
  }

  redirect(completeStep ? "/setup/communication" : "/setup/ai?saved=1");
}
