import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getEnv } from "@/server/env";

let transporter: Transporter | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;",
  })[char] ?? char);
}

function getTransporter(): Transporter {
  const env = getEnv();
  if (!env.SMTP_URL) throw new Error("SMTP_URL is required to send email.");
  transporter ??= nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

function fromAddress(): string {
  const env = getEnv();
  if (!env.SMTP_FROM) throw new Error("SMTP_FROM is required to send email.");
  return env.SMTP_FROM;
}

export async function sendPasswordResetEmail(input: { to: string; name: string; url: string }) {
  const safeName = escapeHtml(input.name);
  const safeUrl = escapeHtml(input.url);

  await getTransporter().sendMail({
    from: fromAddress(),
    to: input.to,
    subject: "Reset your AI Caller password",
    text: `Hi ${input.name},\n\nReset your AI Caller password using this link:\n${input.url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Reset your AI Caller password using the link below.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
}

export async function sendWelcomeEmail(input: { to: string; name: string; temporaryPassword: string; signInUrl: string }) {
  const safeName = escapeHtml(input.name);
  const safeEmail = escapeHtml(input.to);
  const safePassword = escapeHtml(input.temporaryPassword);
  const safeUrl = escapeHtml(input.signInUrl);

  await getTransporter().sendMail({
    from: fromAddress(),
    to: input.to,
    subject: "Welcome to AI Caller — your account is ready",
    text: `Hi ${input.name},\n\nYour AI Caller account has been created from your JVZoo purchase.\n\nLogin: ${input.to}\nTemporary password: ${input.temporaryPassword}\nSign in: ${input.signInUrl}\n\nFor security, use Forgot password after your first login to choose a private password.`,
    html: `<p>Hi ${safeName},</p><p>Your AI Caller account has been created from your JVZoo purchase.</p><p><strong>Login:</strong> ${safeEmail}<br/><strong>Temporary password:</strong> ${safePassword}</p><p><a href="${safeUrl}">Sign in to AI Caller</a></p><p>For security, use <strong>Forgot password</strong> after your first login to choose a private password.</p>`,
  });
}
