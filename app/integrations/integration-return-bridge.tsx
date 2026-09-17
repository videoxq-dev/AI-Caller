"use client";

import { useEffect } from "react";

const supportedProviders = new Set([
  "plivo",
  "telnyx",
  "twilio",
  "whatsapp",
  "credits",
  "openai",
  "gemini",
  "openrouter",
  "google",
  "outlook",
  "calendly",
  "calcom",
]);

function safeReturnPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

type IntegrationRow = { provider?: string; status?: string };

async function getProviderStatus(provider: string) {
  const response = await fetch("/api/integrations", { cache: "no-store" });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  const rows = Array.isArray(payload?.integrations) ? payload.integrations as IntegrationRow[] : [];
  return rows.find((row) => row.provider === provider)?.status ?? null;
}

export function IntegrationReturnBridge() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("provider");
    const returnTo = safeReturnPath(params.get("return"));
    if (!provider || !supportedProviders.has(provider) || !returnTo) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let checks = 0;

    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      const url = new URL(target.href, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/integrations/oauth/")) return;
      url.searchParams.set("return", returnTo);
      target.href = `${url.pathname}${url.search}${url.hash}`;
    };

    document.addEventListener("click", onDocumentClick, true);

    void getProviderStatus(provider).then((initialStatus) => {
      if (cancelled || initialStatus === "CONNECTED") return;
      interval = setInterval(() => {
        checks += 1;
        if (checks >= 60) {
          if (interval) clearInterval(interval);
          interval = null;
          return;
        }
        void getProviderStatus(provider).then((status) => {
          if (cancelled || status !== "CONNECTED") return;
          if (interval) clearInterval(interval);
          window.location.assign(returnTo);
        });
      }, 5000);
    });

    return () => {
      cancelled = true;
      document.removeEventListener("click", onDocumentClick, true);
      if (interval) clearInterval(interval);
    };
  }, []);

  return null;
}
