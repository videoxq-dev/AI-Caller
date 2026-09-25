import { describe, expect, it } from "vitest";
import { normalizeWhitelabelHostname } from "./domain-hostname";

describe("F12-D Whitelabel hostname normalization", () => {
  it("normalizes case, URL input, trailing dots and IDNs", () => {
    expect(normalizeWhitelabelHostname(" HTTPS://App.Example.COM./ ")).toBe("app.example.com");
    expect(normalizeWhitelabelHostname("büro.example.com")).toBe("xn--bro-hoa.example.com");
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "::1",
    "app.example.com:8443",
    "*.example.com",
    "https://app.example.com/client",
    "https://user:pass@app.example.com",
    "app",
    "example.com",
  ])("rejects unsupported hostname input %s", (value) => {
    expect(() => normalizeWhitelabelHostname(value)).toThrow();
  });

  it("rejects canonical and reserved AI Caller hosts", () => {
    expect(() => normalizeWhitelabelHostname("app.aicaller.com", ["app.aicaller.com", "aicaller.com"])).toThrow();
    expect(() => normalizeWhitelabelHostname("clients.aicaller.com", ["aicaller.com"])).toThrow();
  });
});
