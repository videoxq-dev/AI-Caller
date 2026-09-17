export class ProviderRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

function providerMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  const message = record.message;
  return typeof message === "string" ? message : null;
}

export async function providerJson<T>(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (!response.ok) {
      throw new ProviderRequestError(providerMessage(payload) ?? `Provider returned HTTP ${response.status}.`, response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ProviderRequestError("Provider connection timed out.", 504);
    throw new ProviderRequestError("Unable to reach provider.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
