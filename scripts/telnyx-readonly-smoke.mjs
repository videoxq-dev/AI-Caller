#!/usr/bin/env node
// Non-mutating Telnyx API smoke test. No purchases, brand/campaign writes or SMS sends.
import assert from "node:assert/strict";

const key = process.env.HOSTED_TELNYX_API_KEY?.trim();
assert(key, "The selected GitHub environment must define HOSTED_TELNYX_API_KEY.");
assert(process.env.AI_CALLER_E2E_FIXTURES !== "1", "Fixture mode cannot verify live Telnyx APIs.");

const checks = [
  ["Messaging profiles", "/v2/messaging_profiles?page[size]=1"],
  ["10DLC brand listing", "/v2/10dlc/brand?page=1&perPage=1"],
  ["Toll-free verification listing", "/v2/messaging_tollfree/verification/requests?page=1&page_size=1"],
];

let verified = 0;
let blocked = 0;
for (const [name, path] of checks) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://api.telnyx.com" + path, {
      method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (name === "Messaging profiles") throw new Error("Messaging authentication returned HTTP " + response.status);
      blocked += 1;
      console.log("UNVERIFIED: " + name + " returned HTTP " + response.status + " for this API key.");
      continue;
    }
    const payload = await response.json();
    assert(payload && typeof payload === "object", name + ": invalid JSON object");
    // Provider response bodies may contain customer data. Do not log them.
    verified += 1;
    console.log("PASS: " + name + " returned HTTP " + response.status);
  } finally {
    clearTimeout(timeout);
  }
}
console.log("Telnyx authenticated. Read-only checks passed: " + verified + "; unavailable: " + blocked + ".");
console.log("Carrier approvals, assignment, delivery and STOP handling remain unverified.");
if (blocked > 0) {
  // Do not let a green job imply that restricted carrier capabilities passed.
  process.exitCode = 1;
}
