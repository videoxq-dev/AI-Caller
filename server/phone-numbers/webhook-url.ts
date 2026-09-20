import { isIP } from "node:net";
import { AppError } from "@/server/http/errors";

/**
 * Telnyx must reach these URLs from the public internet. BETTER_AUTH_URL may
 * legitimately be localhost for local sign-in, so voice webhooks have their
 * own optional public HTTPS base (such as a tunnel or staging deployment).
 */
export function resolveManagedWebhookBaseUrl(
  authBaseUrl: string,
  publicWebhookBaseUrl?: string,
  allowLocalFixture = false,
) {
  const raw = publicWebhookBaseUrl?.trim() || authBaseUrl.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      "PUBLIC_WEBHOOK_URL_REQUIRED",
      "Set HOSTED_WEBHOOK_BASE_URL to your public HTTPS application URL before purchasing a managed number.",
      422,
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const unbracketed = hostname.replace(/^\[|\]$/g, "");
  const nonpublic = hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")
    || hostname.endsWith(".test") || hostname.endsWith(".invalid")
    || hostname.endsWith(".example") || hostname.endsWith(".localdomain") || hostname.endsWith(".lan")
    || hostname === "example.com" || hostname.endsWith(".example.com")
    || hostname === "example" || hostname === "invalid"
    || isIP(unbracketed) !== 0
    || !hostname.includes(".");

  if (
    url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
    || (!allowLocalFixture && (url.protocol !== "https:" || nonpublic))
    || (allowLocalFixture && !["http:", "https:"].includes(url.protocol))
  ) {
    throw new AppError(
      "PUBLIC_WEBHOOK_URL_REQUIRED",
      "Managed number activation requires a public HTTPS application URL with no path, query, or credentials. Set HOSTED_WEBHOOK_BASE_URL (for example, your HTTPS tunnel) before purchasing.",
      422,
    );
  }

  return url.origin;
}

export function managedNumberWebhookUrls(
  workspaceId: string,
  input: { BETTER_AUTH_URL: string; HOSTED_WEBHOOK_BASE_URL?: string },
  allowLocalFixture = false,
) {
  const base = resolveManagedWebhookBaseUrl(input.BETTER_AUTH_URL, input.HOSTED_WEBHOOK_BASE_URL, allowLocalFixture);
  return {
    voice: `${base}/api/webhooks/voice/telnyx/${workspaceId}`,
    sms: `${base}/api/webhooks/sms/telnyx/${workspaceId}`,
  };
}
