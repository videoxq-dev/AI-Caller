export function isGuardedE2EFixtureMode() {
  if (process.env.CI !== "true" || process.env.AI_CALLER_E2E_FIXTURES !== "1") return false;
  try {
    const host = new URL(process.env.BETTER_AUTH_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}
