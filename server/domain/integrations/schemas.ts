import { z } from "zod";

export const providerIdSchema = z.enum([
  "plivo",
  "telnyx",
  "twilio",
  "whatsapp",
  "credits",
  "openai",
  "gemini",
  "openrouter",
  "google",
  "outlook",
  "calendly",
  "calcom",
]);

export const integrationCategorySchema = z.enum(["AI", "COMMUNICATION", "WHATSAPP", "CALENDAR"]);
export const integrationModeSchema = z.enum(["HOSTED", "BYOP"]);
export const integrationStatusSchema = z.enum(["CONNECTED", "ERROR", "DISCONNECTED"]);
export const capabilitySchema = z.enum(["AI_TEXT", "SMS", "VOICE", "WHATSAPP", "CALENDAR"]);

export const integrationSaveSchema = z.object({
  provider: providerIdSchema,
  category: integrationCategorySchema,
  mode: integrationModeSchema.default("BYOP"),
  credentials: z.record(z.string(), z.string()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const capabilityBindingInputSchema = z.object({
  capability: capabilitySchema,
  mode: integrationModeSchema,
  provider: providerIdSchema.nullable().optional(),
});

const channelBindingSchema = z.object({
  mode: integrationModeSchema,
  provider: providerIdSchema.nullable().optional(),
});

export const communicationSetupSchema = z.object({
  voice: channelBindingSchema.extend({
    numberMode: z.enum(["new", "existing"]).default("new"),
    number: z.string().nullable().optional(),
  }),
  sms: channelBindingSchema.extend({
    numberMode: z.enum(["same", "separate"]).default("same"),
    displayName: z.string().max(100).default(""),
    replyWindow: z.string().default("Always respond"),
    afterHoursBehavior: z.string().default("Auto-reply + collect details"),
  }),
  whatsapp: channelBindingSchema.extend({
    accountMode: z.enum(["new", "existing"]).default("existing"),
  }),
  webchat: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
  completeStep: z.boolean().default(false),
});

export const calendarSetupSchema = z.object({
  provider: z.enum(["google", "outlook", "calendly", "calcom"]),
  meetingDurationMinutes: z.number().int().min(5).max(480).default(30),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(15),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(15),
  availableDays: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).default(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  startTime: z.string().default("09:00"),
  endTime: z.string().default("17:00"),
  timezone: z.string().min(1).default("Africa/Lagos"),
  suggestAlternatives: z.boolean().default(true),
  eventType: z.string().nullable().optional(),
  meetingLocation: z.string().nullable().optional(),
  maxBookingsPerDay: z.number().int().min(1).max(100).default(8),
  completeStep: z.boolean().default(false),
});

export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>;
export type CommunicationSetupInput = z.infer<typeof communicationSetupSchema>;
export type CalendarSetupInput = z.infer<typeof calendarSetupSchema>;
