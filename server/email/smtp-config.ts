import type SMTPTransport from "nodemailer/lib/smtp-transport";

export type SmtpEnvironment = {
  SMTP_URL?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
};

export function smtpTransportConfig(env: SmtpEnvironment): string | SMTPTransport.Options {
  if (env.SMTP_URL?.trim()) return env.SMTP_URL.trim();

  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  if (!host) throw new Error("SMTP_HOST is required to send email.");
  if (!env.SMTP_PORT || !Number.isInteger(env.SMTP_PORT) || env.SMTP_PORT < 1 || env.SMTP_PORT > 65535) throw new Error("A valid SMTP_PORT is required to send email.");
  if (!user) throw new Error("SMTP_USER is required to send email.");
  if (!password?.trim()) throw new Error("SMTP_PASSWORD is required to send email.");

  return {
    host,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    auth: {
      user,
      pass: password,
    },
  };
}
