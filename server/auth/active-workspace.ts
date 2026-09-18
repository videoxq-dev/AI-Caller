import { z } from "zod";

export const ACTIVE_WORKSPACE_COOKIE = "ai-caller-active-workspace";

const workspaceIdSchema = z.string().uuid();

export function readActiveWorkspaceId(headers: Headers) {
  const cookie = headers.get("cookie");
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== ACTIVE_WORKSPACE_COOKIE) continue;
    const value = decodeURIComponent(rawValue.join("="));
    return workspaceIdSchema.safeParse(value).success ? value : null;
  }
  return null;
}

export function activeWorkspaceCookie(workspaceId: string, secure: boolean) {
  const validated = workspaceIdSchema.parse(workspaceId);
  return [
    `${ACTIVE_WORKSPACE_COOKIE}=${encodeURIComponent(validated)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
