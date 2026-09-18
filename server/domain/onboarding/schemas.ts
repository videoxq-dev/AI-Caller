import { z } from "zod";

const businessTimeSchema = z.string().regex(/^(?:[01]\\d|2[0-3]):[0-5]\\d$/, "Time must use 24-hour HH:MM format.");

const businessTimezoneSchema = z.string().trim().min(1).max(120).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a valid IANA timezone.");

export const businessHourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  openTime: businessTimeSchema.nullable().optional(),
  closeTime: businessTimeSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if (!value.enabled) return;
  if (!value.openTime) ctx.addIssue({ code: "custom", path: ["openTime"], message: "Opening time is required for an enabled day." });
  if (!value.closeTime) ctx.addIssue({ code: "custom", path: ["closeTime"], message: "Closing time is required for an enabled day." });
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
  timezone: businessTimezoneSchema,
  summary: z.string().trim().max(4000).nullable().optional(),
  hours: z.array(businessHourSchema).length(7).optional(),
  completeStep: z.boolean().default(false),
});

export const voiceConfigSchema = z.object({
  profileKey: z.string().trim().min(1).max(100).default("ava-us-1"),
  language: z.string().trim().min(2).max(20).default("en-US"),
  speakingRate: z.coerce.number().min(0.75).max(1.25).default(1),
  recordingPolicy: z.enum(["ANNOUNCE", "EXPLICIT_CONSENT"]).default("ANNOUNCE"),
  afterHoursEnabled: z.boolean().default(true),
}).default({
  profileKey: "ava-us-1",
  language: "en-US",
  speakingRate: 1,
  recordingPolicy: "ANNOUNCE",
  afterHoursEnabled: true,
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
  voice: voiceConfigSchema,
  qualification: qualificationConfigSchema,
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
