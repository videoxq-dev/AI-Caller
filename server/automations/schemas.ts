import { z } from "zod";

export const automationKeys = [
  "MISSED_INQUIRY_RECOVERY",
  "QUALIFIED_LEAD_ASSIGNMENT",
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_REMINDER",
  "HUMAN_ESCALATION",
] as const;

export type AutomationKey = typeof automationKeys[number];

const messageTemplate = z.string().trim().min(1).max(2000);
const staffId = z.string().min(1).nullable().default(null);

export const missedInquiryConfigSchema = z.object({
  delayMinutes: z.number().int().min(5).max(24 * 60).default(15),
  channels: z.array(z.enum(["SMS", "WHATSAPP"])).min(1).max(2).default(["SMS"]),
  message: messageTemplate.default("Hi {{name}}, we noticed we missed your message. Reply here and we’ll help you as soon as possible."),
});

export const qualifiedLeadAssignmentConfigSchema = z.object({
  assignedUserId: staffId,
  notifyInApp: z.boolean().default(true),
});

export const appointmentConfirmationConfigSchema = z.object({
  channels: z.array(z.enum(["SMS", "WHATSAPP"])).min(1).max(2).default(["SMS"]),
  message: messageTemplate.default("You’re booked, {{name}}. Your {{service}} appointment is confirmed for {{appointment_date}} at {{appointment_time}}."),
  whatsappTemplateName: z.string().trim().min(1).max(512).nullable().default(null),
  whatsappTemplateLanguage: z.string().trim().min(2).max(20).default("en_US"),
}).superRefine((config, ctx) => {
  if (config.channels.includes("WHATSAPP") && !config.whatsappTemplateName) {
    ctx.addIssue({
      code: "custom",
      path: ["whatsappTemplateName"],
      message: "An approved WhatsApp template is required for automated confirmations.",
    });
  }
});

export const appointmentReminderConfigSchema = z.object({
  firstMinutesBefore: z.number().int().min(15).max(30 * 24 * 60).default(24 * 60),
  secondMinutesBefore: z.number().int().min(15).max(30 * 24 * 60).nullable().default(120),
  channels: z.array(z.enum(["SMS", "WHATSAPP"])).min(1).max(2).default(["SMS"]),
  message: messageTemplate.default("Reminder: your {{service}} appointment is {{appointment_date}} at {{appointment_time}}. Reply here if you need to reschedule."),
  whatsappTemplateName: z.string().trim().min(1).max(512).nullable().default(null),
  whatsappTemplateLanguage: z.string().trim().min(2).max(20).default("en_US"),
}).superRefine((config, ctx) => {
  if (config.secondMinutesBefore !== null && config.secondMinutesBefore >= config.firstMinutesBefore) {
    ctx.addIssue({
      code: "custom",
      path: ["secondMinutesBefore"],
      message: "The second reminder must be closer to the appointment than the first reminder.",
    });
  }
  if (config.channels.includes("WHATSAPP") && !config.whatsappTemplateName) {
    ctx.addIssue({
      code: "custom",
      path: ["whatsappTemplateName"],
      message: "An approved WhatsApp template is required for automated reminders.",
    });
  }
});

export const humanEscalationConfigSchema = z.object({
  assignedUserId: staffId,
  notifyInApp: z.boolean().default(true),
});

const schemas = {
  MISSED_INQUIRY_RECOVERY: missedInquiryConfigSchema,
  QUALIFIED_LEAD_ASSIGNMENT: qualifiedLeadAssignmentConfigSchema,
  APPOINTMENT_CONFIRMATION: appointmentConfirmationConfigSchema,
  APPOINTMENT_REMINDER: appointmentReminderConfigSchema,
  HUMAN_ESCALATION: humanEscalationConfigSchema,
} satisfies Record<AutomationKey, z.ZodType>;

export type MissedInquiryConfig = z.infer<typeof missedInquiryConfigSchema>;
export type QualifiedLeadAssignmentConfig = z.infer<typeof qualifiedLeadAssignmentConfigSchema>;
export type AppointmentConfirmationConfig = z.infer<typeof appointmentConfirmationConfigSchema>;
export type AppointmentReminderConfig = z.infer<typeof appointmentReminderConfigSchema>;
export type HumanEscalationConfig = z.infer<typeof humanEscalationConfigSchema>;

export type AutomationConfigMap = {
  MISSED_INQUIRY_RECOVERY: MissedInquiryConfig;
  QUALIFIED_LEAD_ASSIGNMENT: QualifiedLeadAssignmentConfig;
  APPOINTMENT_CONFIRMATION: AppointmentConfirmationConfig;
  APPOINTMENT_REMINDER: AppointmentReminderConfig;
  HUMAN_ESCALATION: HumanEscalationConfig;
};

export function parseAutomationConfig<K extends AutomationKey>(key: K, value: unknown): AutomationConfigMap[K] {
  return schemas[key].parse(value) as AutomationConfigMap[K];
}

export function defaultAutomationConfig<K extends AutomationKey>(key: K): AutomationConfigMap[K] {
  return parseAutomationConfig(key, {});
}
