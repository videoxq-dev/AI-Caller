import { describe, expect, it } from "vitest";
import { normalizeLocalReturnPath } from "./oauth";

describe("OAuth return paths", () => {
  it("preserves safe local onboarding paths", () => {
    expect(normalizeLocalReturnPath("/setup/calendar?step=4#connect")).toBe("/setup/calendar?step=4#connect");
  });

  it("rejects external and protocol-relative redirects", () => {
    expect(normalizeLocalReturnPath("https://evil.example/steal")).toBe("/integrations");
    expect(normalizeLocalReturnPath("//evil.example/steal")).toBe("/integrations");
    expect(normalizeLocalReturnPath("/\\evil.example/steal")).toBe("/integrations");
  });
});
