import { afterEach, describe, expect, it } from "vitest";
import { isGuardedE2EFixtureMode } from "./e2e-mode";

const original = {
  CI: process.env.CI,
  fixtures: process.env.AI_CALLER_E2E_FIXTURES,
  authUrl: process.env.BETTER_AUTH_URL,
};

afterEach(() => {
  if (original.CI === undefined) delete process.env.CI; else process.env.CI = original.CI;
  if (original.fixtures === undefined) delete process.env.AI_CALLER_E2E_FIXTURES; else process.env.AI_CALLER_E2E_FIXTURES = original.fixtures;
  if (original.authUrl === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = original.authUrl;
});

describe("guarded E2E fixture mode", () => {
  it("requires CI, the explicit fixture flag, and a loopback auth URL", () => {
    process.env.CI = "true";
    process.env.AI_CALLER_E2E_FIXTURES = "1";
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
    expect(isGuardedE2EFixtureMode()).toBe(true);

    process.env.BETTER_AUTH_URL = "https://app.example.com";
    expect(isGuardedE2EFixtureMode()).toBe(false);

    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.CI = "false";
    expect(isGuardedE2EFixtureMode()).toBe(false);

    process.env.CI = "true";
    process.env.AI_CALLER_E2E_FIXTURES = "0";
    expect(isGuardedE2EFixtureMode()).toBe(false);
  });
});
