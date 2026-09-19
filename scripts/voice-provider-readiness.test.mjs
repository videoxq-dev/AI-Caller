import test from "node:test";
import assert from "node:assert/strict";
import { checkOpenAI, checkTelnyxVoice, preflight, run } from "./voice-provider-readiness.mjs";

const env = {
  HOSTED_AI_PROVIDER: "openai",
  HOSTED_AI_API_KEY: "test-ai-key",
  HOSTED_AI_MODEL: "gpt-5.6-luna",
  HOSTED_TELNYX_API_KEY: "test-telnyx-key",
  HOSTED_TELNYX_WEBHOOK_PUBLIC_KEY: "test-public-key",
};

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("preflight rejects missing keys, non-OpenAI provider and CI fixtures", () => {
  assert.deepEqual(preflight({}).failures.length, 3);
  const result = preflight({ ...env, HOSTED_AI_PROVIDER: "openrouter", AI_CALLER_E2E_FIXTURES: "1" });
  assert.equal(result.failures.length, 2);
  assert.equal(preflight(env).model, "gpt-5.6-luna");
});

test("configuration check never invokes provider APIs", async () => {
  const output = [];
  assert.equal(await run(env, {
    fetcher: () => { throw new Error("must not fetch"); },
    log: (s) => output.push(s),
  }), true);
  assert.match(output.join("\n"), /CONFIGURED ONLY/);
});

test("OpenAI probe requests an actual non-stored model response", async () => {
  const result = await checkOpenAI({
    key: "secret", fetcher: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer secret");
      const input = JSON.parse(init.body);
      assert.equal(input.model, "gpt-5.6-luna");
      assert.equal(input.store, false);
      assert.ok(init.signal);
      assert.equal(init.redirect, "error");
      return json({ output: [{ type: "message", content: [{ type: "output_text", text: "READY" }] }] });
    },
  });
  assert.equal(result.generated, true);
});

test("OpenAI probe rejects empty and unexpected responses", async () => {
  await assert.rejects(checkOpenAI({ key: "a", fetcher: async () => json({ output: [] }) }), /UNEXPECTED_MODEL_RESPONSE/);
  await assert.rejects(checkOpenAI({ key: "a", fetcher: async () => json({ output: [{ content: [{ type: "output_text", text: "NOT READY" }] }] }) }), /UNEXPECTED_MODEL_RESPONSE/);
});

test("Telnyx readiness is read-only and empty account is not falsely called voice-ready", async () => {
  const result = await checkTelnyxVoice({
    key: "secret", fetcher: async (url, init) => {
      assert.match(url, /\/v2\/call_control_applications/);
      assert.equal(init.method, "GET");
      return json({ data: [] });
    },
  });
  assert.deepEqual(result, { authenticated: true, callControlApplicationFound: false });
});

test("live probe never logs secrets or provider response bodies on failure", async () => {
  const output = [];
  const ok = await run(env, {
    live: true,
    fetcher: async (url) => url.includes("api.openai.com")
      ? json({ error: { message: "secret customer data" } }, 401)
      : json({ data: [{ id: "provider-id" }] }),
    log: (s) => output.push(s),
  });
  assert.equal(ok, false);
  assert.match(output.join("\n"), /OpenAI Responses — HTTP_401/);
  assert.match(output.join("\n"), /PASS: Telnyx Call Control/);
  assert.doesNotMatch(output.join("\n"), /test-ai-key|test-telnyx-key|provider-id|secret customer data/);
});

test("network exceptions are redacted", async () => {
  await assert.rejects(checkOpenAI({ key: "a", fetcher: async () => {
    throw new Error("Bearer a");
  } }), /^Error: NETWORK_OR_TIMEOUT$/);
});
