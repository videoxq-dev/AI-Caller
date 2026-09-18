import { z } from "zod";

export const AUTH_PASSWORD_RESET_EMAIL = "auth.password-reset-email";
export const COMMERCE_WELCOME_EMAIL = "commerce.welcome-email";
export const TEAM_INVITATION_EMAIL = "team.invitation-email";
export const SMS_INBOUND_RESPONSE = "sms.inbound-response";
export const WHATSAPP_INBOUND_RESPONSE = "whatsapp.inbound-response";

export const passwordResetEmailJobSchema = z.object({
  to: z.string().email(),
  name: z.string().min(1),
  url: z.string().url(),
});

export const teamInvitationEmailJobSchema = z.object({
  to: z.string().email(),
  inviterName: z.string().min(1).max(200),
  workspaceName: z.string().min(1).max(200),
  acceptUrl: z.string().url(),
});

export const welcomeEmailJobSchema = z.object({
  to: z.string().email(),
  name: z.string().min(1),
  temporaryPassword: z.string().min(12),
  signInUrl: z.string().url(),
});

export const smsInboundResponseJobSchema = z.object({
  workspaceId: z.string().uuid(),
  provider: z.enum(["telnyx", "twilio", "plivo"]),
  webhookEventId: z.string().uuid(),
  externalMessageId: z.string().min(1).max(500),
  customerNumber: z.string().min(1).max(80),
  destinationNumber: z.string().min(1).max(80),
  text: z.string().min(1).max(10_000),
});

export const whatsappInboundResponseJobSchema = z.object({
  workspaceId: z.string().uuid(),
  webhookEventId: z.string().uuid(),
  externalMessageId: z.string().min(1).max(500),
  phoneNumberId: z.string().min(1).max(200),
  customerWaId: z.string().min(1).max(80),
  profileName: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(10_000),
  occurredAt: z.string().datetime().nullable(),
});

export type PasswordResetEmailJob = z.infer<typeof passwordResetEmailJobSchema>;
export type WelcomeEmailJob = z.infer<typeof welcomeEmailJobSchema>;
export type TeamInvitationEmailJob = z.infer<typeof teamInvitationEmailJobSchema>;
export type SmsInboundResponseJob = z.infer<typeof smsInboundResponseJobSchema>;
export type WhatsAppInboundResponseJob = z.infer<typeof whatsappInboundResponseJobSchema>;
