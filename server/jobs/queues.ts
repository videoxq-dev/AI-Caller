import { z } from "zod";

export const AUTH_PASSWORD_RESET_EMAIL = "auth.password-reset-email";
export const COMMERCE_WELCOME_EMAIL = "commerce.welcome-email";

export const passwordResetEmailJobSchema = z.object({
  to: z.string().email(),
  name: z.string().min(1),
  url: z.string().url(),
});

export const welcomeEmailJobSchema = z.object({
  to: z.string().email(),
  name: z.string().min(1),
  temporaryPassword: z.string().min(12),
  signInUrl: z.string().url(),
});

export type PasswordResetEmailJob = z.infer<typeof passwordResetEmailJobSchema>;
export type WelcomeEmailJob = z.infer<typeof welcomeEmailJobSchema>;
