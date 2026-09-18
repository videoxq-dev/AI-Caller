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

const communicationProviderSchema = z.enum(["plivo", "telnyx", "twilio"]);
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
    number: z.string().nullable().optional(),
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
}).superRefine((input, ctx) => {
  for (const [field, channel] of [["voice", input.voice], ["sms", input.sms]] as const) {
    if (channel.mode === "BYOP") {
      const parsed = communicationProviderSchema.safeParse(channel.provider);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", path: [field, "provider"], message: "BYOP voice and SMS require Telnyx, Plivo, or Twilio." });
      }
    } else if (channel.provider != null) {
      ctx.addIssue({ code: "custom", path: [field, "provider"], message: "Hosted voice and SMS must not specify a BYOP provider." });
    }
  }

  if (input.completeStep && (input.voice.mode !== "BYOP" || input.voice.provider !== "telnyx")) {
    ctx.addIssue({
      code: "custom",
      path: ["voice", "provider"],
      message: "Milestone 7 inbound voice currently requires a connected Telnyx BYOP integration before setup can be completed.",
    });
  }

  if (input.completeStep && input.sms.mode === "HOSTED") {
    const number = input.sms.numberMode === "separate" ? input.sms.number : input.voice.number;
    if (!number?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["sms", "number"],
        message: input.sms.numberMode === "separate"
          ? "Assign a dedicated SMS number before completing setup."
          : "Choose a business phone number before completing hosted SMS setup.",
      });
    }
  }

  if (input.whatsapp.mode !== "BYOP" || input.whatsapp.provider !== "whatsapp") {
    ctx.addIssue({ code: "custom", path: ["whatsapp", "provider"], message: "WhatsApp must use the Meta Embedded Signup integration." });
  }
});

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Time must use 24-hour HH:MM format.");
const timeZoneSchema = z.string().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a valid IANA timezone.");

export const calendarSetupSchema = z.object({
  provider: z.enum(["google", "outlook", "calendly", "calcom"]),
  meetingDurationMinutes: z.number().int().min(5).max(480).default(30),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(15),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(15),
  availableDays: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1, "Choose at least one available day.").default(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  startTime: timeSchema.default("09:00"),
  endTime: timeSchema.default("17:00"),
  timezone: timeZoneSchema.default("Africa/Lagos"),
  suggestAlternatives: z.boolean().default(true),
  eventType: z.string().max(200).nullable().optional(),
  meetingLocation: z.string().max(200).nullable().optional(),
  maxBookingsPerDay: z.number().int().min(1).max(100).default(8),
  completeStep: z.boolean().default(false),
}).superRefine((input, ctx) => {
  if (input.startTime >= input.endTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "End time must be later than start time." });
  }
});

export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>;
export type CommunicationSetupInput = z.infer<typeof communicationSetupSchema>;
export type CalendarSetupInput = z.infer<typeof calendarSetupSchema>;
