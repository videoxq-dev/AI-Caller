import { describe, expect, it } from "vitest";
import { hasWorkspacePermission } from "./permissions";

describe("workspace permissions", () => {
  it("keeps team and automation administration away from staff", () => {
    expect(hasWorkspacePermission("OWNER", "team.manage")).toBe(true);
    expect(hasWorkspacePermission("ADMIN", "team.manage")).toBe(true);
    expect(hasWorkspacePermission("STAFF", "team.manage")).toBe(false);
    expect(hasWorkspacePermission("STAFF", "automation.manage")).toBe(false);
  });

  it("allows staff to take over, reply, and self-assign without assigning others", () => {
    expect(hasWorkspacePermission("STAFF", "conversation.takeover")).toBe(true);
    expect(hasWorkspacePermission("STAFF", "conversation.reply")).toBe(true);
    expect(hasWorkspacePermission("STAFF", "conversation.assign.self")).toBe(true);
    expect(hasWorkspacePermission("STAFF", "conversation.assign.any")).toBe(false);
  });
});
