import { describe, expect, it } from "vitest";
import { ACTIVE_WORKSPACE_COOKIE, activeWorkspaceCookie, readActiveWorkspaceId } from "./active-workspace";

describe("active workspace cookie", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("round-trips a valid workspace id and ignores invalid values", () => {
    const cookie = activeWorkspaceCookie(id, false);
    expect(cookie).toContain(`${ACTIVE_WORKSPACE_COOKIE}=${id}`);
    expect(readActiveWorkspaceId(new Headers({ cookie }))).toBe(id);
    expect(readActiveWorkspaceId(new Headers({ cookie: `${ACTIVE_WORKSPACE_COOKIE}=not-a-uuid` }))).toBeNull();
  });

  it("marks production cookies secure", () => {
    expect(activeWorkspaceCookie(id, true)).toContain("Secure");
  });
});
