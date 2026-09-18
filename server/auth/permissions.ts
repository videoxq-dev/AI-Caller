import { AppError } from "@/server/http/errors";
import type { WorkspaceMembership } from "./workspace-repository";

export type WorkspaceRole = WorkspaceMembership["role"];
export type WorkspacePermission =
  | "team.read"
  | "team.manage"
  | "workspace.switch"
  | "conversation.takeover"
  | "conversation.reply"
  | "conversation.assign.self"
  | "conversation.assign.any"
  | "automation.manage"
  | "integration.manage"
  | "billing.manage";

const rolePermissions: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  OWNER: new Set([
    "team.read",
    "team.manage",
    "workspace.switch",
    "conversation.takeover",
    "conversation.reply",
    "conversation.assign.self",
    "conversation.assign.any",
    "automation.manage",
    "integration.manage",
    "billing.manage",
  ]),
  ADMIN: new Set([
    "team.read",
    "team.manage",
    "workspace.switch",
    "conversation.takeover",
    "conversation.reply",
    "conversation.assign.self",
    "conversation.assign.any",
    "automation.manage",
    "integration.manage",
  ]),
  STAFF: new Set([
    "team.read",
    "workspace.switch",
    "conversation.takeover",
    "conversation.reply",
    "conversation.assign.self",
  ]),
};

export function hasWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission) {
  return rolePermissions[role].has(permission);
}

export function requireWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission) {
  if (!hasWorkspacePermission(role, permission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
}
