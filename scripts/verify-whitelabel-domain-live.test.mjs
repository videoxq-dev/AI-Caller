import assert from "node:assert/strict";
import test from "node:test";
import {
  checkWhitelabelPublicDns,
  checkWhitelabelHoldingResponse,
  checkWhitelabelHttpReachability,
} from "./whitelabel-live-verification.mjs";

const valid = {
  a: ["203.0.113.25"], aaaa: [],
  txt: ["aicaller-verification=unique-proof"],
  expectedIpv4: "203.0.113.25",
  expectedTxt: "aicaller-verification=unique-proof",
};
test("accepts correct public DNS and account proof", () => {
  assert.doesNotThrow(() => checkWhitelabelPublicDns(valid));
});
test("rejects A drift, conflicting AAAA, and missing/wrong TXT", () => {
  for (const changed of [
    { a: ["198.51.100.24"] },
    { aaaa: ["2001:db8::5"] },
    { txt: [] },
    { expectedTxt: "aicaller-verification=wrong-proof" },
  ]) {
    assert.throws(() => checkWhitelabelPublicDns({ ...valid, ...changed }));
  }
});
test("accepts the domain-specific holding response only", () => {
  assert.doesNotThrow(() => checkWhitelabelHoldingResponse({
    statusCode: 200,
    hostname: "app.example.com",
    body: { status: "domain-ready", host: "app.example.com" },
  }));
  for (const changed of [
    { statusCode: 404 },
    { body: { status: "domain-ready", host: "someone-else.example.com" } },
    { body: { status: "ok" } },
  ]) {
    assert.throws(() => checkWhitelabelHoldingResponse({
      statusCode: 200,
      hostname: "app.example.com",
      body: { status: "domain-ready", host: "app.example.com" },
      ...changed,
    }));
  }
});

test("accepts any valid HTTP response from public port 80 and rejects missing transport response", () => {
  for (const statusCode of [200, 301, 308, 404]) {
    assert.doesNotThrow(() => checkWhitelabelHttpReachability({ statusCode }));
  }
  for (const statusCode of [0, 99, 600, undefined]) {
    assert.throws(() => checkWhitelabelHttpReachability({ statusCode }));
  }
});
