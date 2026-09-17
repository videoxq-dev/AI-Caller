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
  if (!env.SMTP_URL) {
    throw new Error("SMTP_URL is required to send authentication email.");
  }

  transporter ??= nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

export async function sendPasswordResetEmail(input: { to: string; name: string; url: string }) {
  const env = getEnv();
  if (!env.SMTP_FROM) {
    throw new Error("SMTP_FROM is required to send authentication email.");
  }

  const safeName = escapeHtml(input.name);
  const safeUrl = escapeHtml(input.url);

  await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: input.to,
    subject: "Reset your AI Caller password",
    text: `Hi ${input.name},\n\nReset your AI Caller password using this link:\n${input.url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Reset your AI Caller password using the link below.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
}
