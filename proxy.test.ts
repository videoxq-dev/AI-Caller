import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import { resetEnvForTests } from "@/server/env";
import { proxy } from "./proxy";

describe("F12-D6 Next host proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("leaves the canonical AI Caller host untouched", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    resetEnvForTests();
    const response = proxy(new NextRequest("https://app.aicaller.com/dashboard", {
      headers: { host: "app.aicaller.com" },
    }));
    expect(isRewrite(response)).toBe(false);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rewrites a custom hostname to the holding route without redirecting the browser", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    resetEnvForTests();
    const response = proxy(new NextRequest("https://clients.stratosassist.com/dashboard", {
      headers: { host: "clients.stratosassist.com" },
    }));
    expect(isRewrite(response)).toBe(true);
    expect(getRewrittenUrl(response)).toBe(
      "https://clients.stratosassist.com/api/whitelabel/domain-pending",
    );
  });

  it("lets the holding route execute once for a non-canonical host instead of looping", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    resetEnvForTests();
    const response = proxy(new NextRequest(
      "https://clients.stratosassist.com/api/whitelabel/domain-pending",
      { headers: { host: "clients.stratosassist.com" } },
    ));
    expect(isRewrite(response)).toBe(false);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rewrites malformed or unknown hosts instead of exposing canonical routes", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.aicaller.com");
    resetEnvForTests();
    const response = proxy(new NextRequest("https://unknown.example.com/settings", {
      headers: { host: "unknown.example.com" },
    }));
    expect(isRewrite(response)).toBe(true);
  });
});
