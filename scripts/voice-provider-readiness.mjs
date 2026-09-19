#!/usr/bin/env node
// V1 provider-readiness probe: configuration checks are free; --live opts in to one
// small OpenAI generation and one read-only Telnyx Call Control request.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MODEL = "gpt-5.6-luna";
const TIMEOUT_MS = 15000;

export function preflight(env) {
  const failures = [];
  if (env.HOSTED_AI_PROVIDER && env.HOSTED_AI_PROVIDER !== "openai") {
    failures.push("HOSTED_AI_PROVIDER must be openai for this acceptance stage.");
  }
  if (!env.HOSTED_AI_API_KEY?.trim()) failures.push("HOSTED_AI_API_KEY is missing.");
  if (!env.HOSTED_TELNYX_API_KEY?.trim()) failures.push("HOSTED_TELNYX_API_KEY is missing.");
  if (!env.HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY?.trim()) {
    failures.push("HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY is missing; signed call webhooks cannot be verified.");
  }
  if (env.AI_CALLER_E2E_FIXTURES === "1") failures.push("Fixture mode cannot verify live providers.");
  return { model: env.HOSTED_AI_MODEL?.trim() || MODEL, failures };
}

async function getJson(url, init, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Deliberately do not log exception messages, request headers, or provider bodies.
    throw new Error("NETWORK_OR_TIMEOUT");
  }
  if (!response.ok) throw new Error("HTTP_" + response.status);
  try {
    return await response.json();
  } catch {
    throw new Error("INVALID_PROVIDER_JSON");
  }
}

export async function checkOpenAI({ key, model = MODEL, fetcher = fetch }) {
  const body = await getJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, store: false, max_output_tokens: 64,
      input: "Return exactly the word READY, in capitals, and nothing else.",
    }),
  }, fetcher);
  const text = Array.isArray(body?.output)
    ? body.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .filter((item) => item?.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text).join("").trim()
    : "";
  if (text !== "READY") throw new Error("UNEXPECTED_MODEL_RESPONSE");
  return { model, generated: true };
}

export async function checkTelnyxVoice({ key, fetcher = fetch }) {
  const body = await getJson("https://api.telnyx.com/v2/call_control_applications?page[size]=1", {
    method: "GET",
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
  }, fetcher);
  if (!Array.isArray(body?.data)) throw new Error("INVALID_CALL_CONTROL_RESPONSE");
  return { authenticated: true, callControlApplicationFound: body.data.length > 0 };
}

export async function run(env, { live = false, fetcher = fetch, log = console.log } = {}) {
  const { model, failures } = preflight(env);
  log("V1 voice provider readiness | OpenAI model: " + model);
  for (const problem of failures) log("FAIL: " + problem);
  if (failures.length) return false;
  if (!live) {
    log("CONFIGURED ONLY: credentials exist; no network call made.");
    log("Run npm run verify:voice-providers:live to test real account access and model generation.");
    return true;
  }

  let passed = true;
  for (const [name, task] of [
    ["OpenAI Responses", () => checkOpenAI({ key: env.HOSTED_AI_API_KEY.trim(), model, fetcher })],
    ["Telnyx Call Control", () => checkTelnyxVoice({ key: env.HOSTED_TELNYX_API_KEY.trim(), fetcher })],
  ]) {
    const started = Date.now();
    try {
      const result = await task();
      log("PASS: " + name + " (" + (Date.now() - started) + "ms)" +
        (name === "Telnyx Call Control" && !result.callControlApplicationFound
          ? " — account authenticated; no Call Control application found yet." : ""));
    } catch (error) {
      passed = false;
      log("FAIL: " + name + " — " + (error instanceof Error ? error.message : "UNKNOWN_ERROR"));
    }
  }
  log(passed
    ? "V1 PROVIDER PROBE PASS. This does not verify inbound calls, live speech or US SMS registration."
    : "V1 PROVIDER PROBE FAIL. Resolve failures before voice-call acceptance.");
  return passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync(".env.local") && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env.local"); // Existing shell variables are not overwritten.
  }
  run(process.env, { live: process.argv.includes("--live") })
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .catch(() => { console.error("FAIL: readiness probe could not complete."); process.exitCode = 1; });
}
