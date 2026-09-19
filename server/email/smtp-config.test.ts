import { describe, expect, it } from "vitest";
import { smtpTransportConfig } from "./smtp-config";

describe("SMTP transport configuration", () => {
  it("uses SMTP_URL when provided for backwards compatibility", () => {
    expect(smtpTransportConfig({
      SMTP_URL: "smtp://legacy:secret@smtp.example.com:587",
      SMTP_HOST: "ignored.example.com",
      SMTP_PORT: 2525,
      SMTP_USER: "ignored",
      SMTP_PASSWORD: "ignored",
    })).toBe("smtp://legacy:secret@smtp.example.com:587");
  });

  it("builds a custom authenticated SMTP transport from separate fields", () => {
    expect(smtpTransportConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "secret",
    })).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "mailer", pass: "secret" },
    });
  });

  it("ignores a blank legacy URL and uses structured credentials", () => {
    expect(smtpTransportConfig({
      SMTP_URL: "  ", SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 587, SMTP_USER: "mailer", SMTP_PASSWORD: "secret",
    })).toMatchObject({ host: "smtp.example.com", secure: false });
  });

  it("preserves meaningful whitespace in SMTP passwords", () => {
    expect(smtpTransportConfig({
      SMTP_HOST: "smtp.example.com", SMTP_PORT: 587,
      SMTP_USER: "mailer", SMTP_PASSWORD: " pass with trailing space ",
    })).toMatchObject({ auth: { user: "mailer", pass: " pass with trailing space " } });
  });

  it("defaults port 465 to a secure connection", () => {
    expect(smtpTransportConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 465,
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "secret",
    })).toMatchObject({ secure: true });
  });

  it("rejects invalid SMTP ports", () => {
    expect(() => smtpTransportConfig({
      SMTP_HOST: "smtp.example.com", SMTP_PORT: 65536,
      SMTP_USER: "mailer", SMTP_PASSWORD: "secret",
    })).toThrow("valid SMTP_PORT");
  });

  it("fails clearly when required custom SMTP fields are missing", () => {
    expect(() => smtpTransportConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 587,
      SMTP_USER: "mailer",
    })).toThrow("SMTP_PASSWORD is required");
  });
});
