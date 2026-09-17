import { getEnv } from "@/server/env";
import { decryptIntegrationCredentials, type EncryptedSecretEnvelope } from "@/server/security/secrets";
import type { AIProvider } from "./contracts";
import { providerJson } from "./http";
import type { PrivateIntegration } from "./connections";

type Credentials = Record<string, string>;
type Message = { role: "system" | "user" | "assistant"; content: string };

type OpenAICompatibleResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type GeminiPart = { text?: string };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
};

function decryptCredentials(input: PrivateIntegration) {
  if (!input.encryptedCredentials) throw new Error(`No saved credentials are available for ${input.provider}.`);
  return decryptIntegrationCredentials<Credentials>(input.encryptedCredentials as EncryptedSecretEnvelope);
}

function requireCredential(values: Credentials, key: string, label: string) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function settingString(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class OpenAICompatibleProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly endpoint: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(input: { messages: Message[]; model?: string }) {
    const model = input.model?.trim() || this.defaultModel;
    const response = await providerJson<OpenAICompatibleResponse>(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify({ model, messages: input.messages }),
    }, this.fetcher);

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("AI provider returned an empty response.");
    return { text, raw: response };
  }
}

class GeminiProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(input: { messages: Message[]; model?: string }) {
    const model = input.model?.trim() || this.defaultModel;
    const systemText = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n").trim();
    const contents = input.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));

    const response = await providerJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          contents,
        }),
      },
      this.fetcher,
    );

    const text = response.candidates?.[0]?.content?.parts?.map((part: GeminiPart) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned an empty response.");
    return { text, raw: response };
  }
}

export function createAIProvider(input: PrivateIntegration, fetcher: typeof fetch = fetch): AIProvider {
  const values = decryptCredentials(input);
  const model = settingString(input.settings, "model");

  if (input.provider === "openai") {
    return new OpenAICompatibleProvider(
      requireCredential(values, "apiKey", "OpenAI API key"),
      model ?? "gpt-4.1-mini",
      "https://api.openai.com/v1/chat/completions",
      {},
      fetcher,
    );
  }

  if (input.provider === "openrouter") {
    const siteUrl = settingString(input.settings, "siteUrl");
    return new OpenAICompatibleProvider(
      requireCredential(values, "apiKey", "OpenRouter API key"),
      model ?? "openai/gpt-4.1-mini",
      "https://openrouter.ai/api/v1/chat/completions",
      {
        ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}),
        "X-Title": "AI Caller",
      },
      fetcher,
    );
  }

  if (input.provider === "gemini") {
    return new GeminiProvider(
      requireCredential(values, "apiKey", "Gemini API key"),
      model ?? "gemini-2.5-flash",
      fetcher,
    );
  }

  throw new Error(`AI generation is not supported by provider ${input.provider}.`);
}

export function createHostedAIProvider(fetcher: typeof fetch = fetch): AIProvider {
  const env = getEnv();
  if (!env.HOSTED_AI_API_KEY) throw new Error("Hosted AI is not configured on the server.");

  if (env.HOSTED_AI_PROVIDER === "gemini") {
    return new GeminiProvider(env.HOSTED_AI_API_KEY, env.HOSTED_AI_MODEL ?? "gemini-2.5-flash", fetcher);
  }

  if (env.HOSTED_AI_PROVIDER === "openrouter") {
    return new OpenAICompatibleProvider(
      env.HOSTED_AI_API_KEY,
      env.HOSTED_AI_MODEL ?? "openai/gpt-4.1-mini",
      "https://openrouter.ai/api/v1/chat/completions",
      { "X-Title": "AI Caller Hosted" },
      fetcher,
    );
  }

  return new OpenAICompatibleProvider(
    env.HOSTED_AI_API_KEY,
    env.HOSTED_AI_MODEL ?? "gpt-4.1-mini",
    "https://api.openai.com/v1/chat/completions",
    {},
    fetcher,
  );
}
