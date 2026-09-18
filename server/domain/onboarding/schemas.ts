import { z } from "zod";

export const businessHourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  openTime: z.string().max(16).nullable().optional(),
  closeTime: z.string().max(16).nullable().optional(),
});

export const businessProfileInputSchema = z.object({
  businessName: z.string().trim().min(1).max(160),
  industry: z.string().trim().max(120).nullable().optional(),
  websiteUrl: z.string().trim().url().nullable().optional().or(z.literal("")),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(240).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(32).nullable().optional(),
  country: z.string().trim().max(120).nullable().optional(),
  serviceRadius: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(4000).nullable().optional(),
  hours: z.array(businessHourSchema).length(7).optional(),
  completeStep: z.boolean().default(false),
});

export const voiceConfigSchema = z.object({
  profileKey: z.string().trim().min(1).max(100).default("ava-us-1"),
  language: z.string().trim().min(2).max(20).default("en-US"),
  speakingRate: z.coerce.number().min(0.75).max(1.25).default(1),
  recordingPolicy: z.enum(["ANNOUNCE", "EXPLICIT_CONSENT"]).default("ANNOUNCE"),
}).default({
  profileKey: "ava-us-1",
  language: "en-US",
  speakingRate: 1,
  recordingPolicy: "ANNOUNCE",
});

export const qualificationCriterionSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(300),
  required: z.boolean().default(true),
});

export const qualificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  criteria: z.array(qualificationCriterionSchema).max(10).default([]),
}).default({ enabled: false, criteria: [] });

export const aiAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tone: z.string().trim().min(1).max(120),
  primaryGoal: z.string().trim().min(1).max(160),
  whenUnsure: z.string().trim().min(1).max(160),
  advancedInstructions: z.string().trim().max(8000).nullable().optional(),
  openingMessage: z.string().trim().max(2000).nullable().optional(),
  escalationMessage: z.string().trim().max(2000).nullable().optional(),
  guardrails: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  completeStep: z.boolean().default(false),
});

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(3000).nullable().optional(),
  priceText: z.string().trim().max(160).nullable().optional(),
  durationMinutes: z.number().int().positive().max(1440).nullable().optional(),
  active: z.boolean().default(true),
});

export const faqInputSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(5000),
  active: z.boolean().default(true),
});

export const policyInputSchema = z.object({
  type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(10000),
});

export const setupStepSchema = z.enum(["business", "ai", "communication", "calendar", "test", "live"]);

export type BusinessProfileInput = z.infer<typeof businessProfileInputSchema>;
export type AIAgentInput = z.infer<typeof aiAgentInputSchema>;
export type ServiceInput = z.infer<typeof serviceInputSchema>;
export type FAQInput = z.infer<typeof faqInputSchema>;
export type PolicyInput = z.infer<typeof policyInputSchema>;
