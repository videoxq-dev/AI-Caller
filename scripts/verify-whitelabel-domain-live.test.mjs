import { describe, expect, it } from "vitest";
import {
  checkWhitelabelPublicDns,
  checkWhitelabelHoldingResponse,
  checkWhitelabelHttpReachability,
  checkWhitelabelStoredCertificateExpiry,
} from "./whitelabel-live-verification.mjs";

const valid = {
  a: ["203.0.113.25"],
  aaaa: [],
  txt: ["aicaller-verification=unique-proof"],
  expectedIpv4: "203.0.113.25",
  expectedTxt: "aicaller-verification=unique-proof",
};

describe("F12-D8 live-domain verification helpers", () => {
  it("accepts correct public DNS and account proof", () => {
    expect(() => checkWhitelabelPublicDns(valid)).not.toThrow();
  });

  it("rejects A drift, conflicting AAAA, and missing/wrong TXT", () => {
    for (const changed of [
      { a: ["198.51.100.24"] },
      { aaaa: ["2001:db8::5"] },
      { txt: [] },
      { expectedTxt: "aicaller-verification=wrong-proof" },
    ]) {
      expect(() => checkWhitelabelPublicDns({ ...valid, ...changed })).toThrow();
    }
  });

  it("accepts the domain-specific holding response only", () => {
    expect(() => checkWhitelabelHoldingResponse({
      statusCode: 200,
      hostname: "app.example.com",
      body: { status: "domain-ready", host: "app.example.com" },
    })).not.toThrow();

    for (const changed of [
      { statusCode: 404 },
      { body: { status: "domain-ready", host: "someone-else.example.com" } },
      { body: { status: "ok" } },
    ]) {
      expect(() => checkWhitelabelHoldingResponse({
        statusCode: 200,
        hostname: "app.example.com",
        body: { status: "domain-ready", host: "app.example.com" },
        ...changed,
      })).toThrow();
    }
  });

  it("accepts any valid HTTP response from public port 80 and rejects missing transport response", () => {
    for (const statusCode of [200, 301, 308, 404]) {
      expect(() => checkWhitelabelHttpReachability({ statusCode })).not.toThrow();
    }
    for (const statusCode of [0, 99, 600, undefined]) {
      expect(() => checkWhitelabelHttpReachability({ statusCode })).toThrow();
    }
  });

  it("requires the live DB certificate expiry to match the served certificate", () => {
    const servedExpiry = new Date("2026-12-01T00:00:00.000Z");
    expect(() => checkWhitelabelStoredCertificateExpiry({
      servedExpiry,
      storedExpiry: new Date("2026-12-01T00:00:00.500Z"),
    })).not.toThrow();
    expect(() => checkWhitelabelStoredCertificateExpiry({
      servedExpiry,
      storedExpiry: new Date("2026-12-01T00:00:02.000Z"),
    })).toThrow();
    expect(() => checkWhitelabelStoredCertificateExpiry({
      servedExpiry,
      storedExpiry: "not-a-date",
    })).toThrow();
  });
});
