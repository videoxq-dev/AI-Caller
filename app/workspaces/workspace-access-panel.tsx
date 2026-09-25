"use client";

import { useEffect, useState, type FormEvent } from "react";

export type ManagedAgencyWorkspace = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: "ACTIVE" | "SUSPENDED";
  kind: "PRIMARY" | "ADDITIONAL";
};

type AccessMember = {
  userId: string;
  name: string;
  email: string;
  role: "OWNER" | "ADMIN" | "STAFF";
  accessKind: "AGENCY_OWNER" | "CLIENT_OWNER" | "TEAM";
};

type AccessInvitation = {
  id: string;
  email: string;
  role: "OWNER" | "ADMIN" | "STAFF";
  accessKind: "CLIENT_OWNER" | "TEAM";
  expiresAt: string;
};

type AccessData = {
  workspace: {
    workspaceId: string;
    workspaceName: string;
    kind: "PRIMARY" | "ADDITIONAL";
  };
  members: AccessMember[];
  invitations: AccessInvitation[];
  plan: {
    id: string;
    name: string;
    subUserLimit: number;
    commercialSeatPackage: "UNLIMITED" | null;
    activeSubUsers: number;
    pendingInvitations: number;
    usedSeats: number;
    availableSeats: number;
  };
};

type InviteRole = "CLIENT_OWNER" | "ADMIN" | "STAFF";

function apiError(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return fallback;
}

export function WorkspaceAccessPanel({
  workspace,
  onClose,
}: {
  workspace: ManagedAgencyWorkspace;
  onClose: () => void;
}) {
  const [data, setData] = useState<AccessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>(workspace.kind === "ADDITIONAL" ? "CLIENT_OWNER" : "STAFF");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`/api/agency/workspaces/${workspace.workspaceId}/access`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "Unable to load workspace access."));
      setData(payload as AccessData);
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Unable to load workspace access.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspace.workspaceId, reloadKey]);

  const clientOwnerExists = Boolean(data?.members.some((member) => member.accessKind === "CLIENT_OWNER"));
  const clientOwnerPending = Boolean(data?.invitations.some((invitation) => invitation.accessKind === "CLIENT_OWNER"));
  const clientOwnerUnavailable = workspace.kind !== "ADDITIONAL" || clientOwnerExists || clientOwnerPending;
  const staffSeatUnavailable = (data?.plan.availableSeats ?? 0) <= 0;
  const selectedRoleUnavailable = role === "CLIENT_OWNER" ? clientOwnerUnavailable : staffSeatUnavailable;

  useEffect(() => {
    if (role === "CLIENT_OWNER" && clientOwnerUnavailable) {
      setRole("STAFF");
    }
  }, [clientOwnerUnavailable, role]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || selectedRoleUnavailable || !email.trim()) return;
    setBusy("invite");
    setError(null);
    try {
      const response = await fetch(
        `/api/agency/workspaces/${workspace.workspaceId}/access/invitations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), role }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "Unable to send invitation."));
      setEmail("");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send invitation.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    if (busy) return;
    setBusy(`invite:${invitationId}`);
    setError(null);
    try {
      const response = await fetch(
        `/api/agency/workspaces/${workspace.workspaceId}/access/invitations/${invitationId}`,
        { method: "DELETE" },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "Unable to revoke invitation."));
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to revoke invitation.");
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(userId: string) {
    if (busy) return;
    setBusy(`member:${userId}`);
    setError(null);
    try {
      const response = await fetch(
        `/api/agency/workspaces/${workspace.workspaceId}/access/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "Unable to remove access."));
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to remove access.");
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(userId: string, nextRole: "ADMIN" | "STAFF") {
    if (busy) return;
    setBusy(`member:${userId}`);
    setError(null);
    try {
      const response = await fetch(
        `/api/agency/workspaces/${workspace.workspaceId}/access/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: nextRole }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "Unable to change role."));
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to change role.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="agencyAccessCard" aria-label={`Manage access for ${workspace.workspaceName}`}>
      <div className="agencyAccessHeader">
        <div>
          <p className="agencyEyebrow">Workspace access</p>
          <h2>{workspace.workspaceName}</h2>
          <p>
            Commercial ownership stays with your Agency account. Client owners and team members receive access only to this workspace.
          </p>
        </div>
        <button type="button" className="agencySecondaryButton" onClick={onClose}>Close</button>
      </div>

      {error && <div className="agencyActionError" role="alert">{error}</div>}
      {loading && <p className="agencyEmpty">Loading workspace access…</p>}

      {!loading && data && (
        <>
          <div className="agencyAccessSummary">
            <div>
              <span>Client owner</span>
              <strong>{clientOwnerExists ? "Connected" : clientOwnerPending ? "Invited" : "Not invited"}</strong>
              <small>Does not consume a sub-user seat.</small>
            </div>
            <div>
              <span>Admin / staff seats</span>
              <strong>{data.plan.usedSeats} / {data.plan.subUserLimit}</strong>
              <small>{data.plan.availableSeats} seat{data.plan.availableSeats === 1 ? "" : "s"} available on {data.plan.commercialSeatPackage === "UNLIMITED" ? "Unlimited" : data.plan.name}.</small>
            </div>
          </div>

          <form className="agencyAccessInvite" onSubmit={(event) => void invite(event)}>
            <label htmlFor="agency-access-email">Invite someone</label>
            <div className="agencyAccessInviteFields">
              <input
                id="agency-access-email"
                type="email"
                required
                maxLength={320}
                placeholder="name@business.com"
                value={email}
                disabled={busy !== null}
                onChange={(event) => setEmail(event.target.value)}
              />
              <select
                aria-label="Access role"
                value={role}
                disabled={busy !== null}
                onChange={(event) => setRole(event.target.value as InviteRole)}
              >
                {workspace.kind === "ADDITIONAL" && (
                  <option value="CLIENT_OWNER" disabled={clientOwnerUnavailable}>Client owner</option>
                )}
                <option value="ADMIN" disabled={staffSeatUnavailable}>Admin</option>
                <option value="STAFF" disabled={staffSeatUnavailable}>Staff</option>
              </select>
              <button
                type="submit"
                className="agencyCreateButton"
                disabled={busy !== null || selectedRoleUnavailable || !email.trim()}
              >
                {busy === "invite" ? "Sending…" : "Send invite"}
              </button>
            </div>
            {staffSeatUnavailable && (
              <p className="agencyAccessHint">
                This workspace has no available Admin/Staff seats. Client-owner access remains separate from the sub-user seat limit.
              </p>
            )}
          </form>

          <div className="agencyAccessSection">
            <h3>People with access</h3>
            {data.members.map((member) => (
              <div className="agencyAccessRow" key={member.userId}>
                <div>
                  <strong>{member.name || member.email}</strong>
                  <span>{member.email}</span>
                </div>
                <span className="agencyAccessRole">
                  {member.accessKind === "AGENCY_OWNER"
                    ? "Agency owner"
                    : member.accessKind === "CLIENT_OWNER"
                      ? "Client owner"
                      : member.role === "ADMIN" ? "Admin" : "Staff"}
                </span>
                {member.accessKind === "TEAM" ? (
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={busy !== null}
                    onChange={(event) => void changeRole(member.userId, event.target.value as "ADMIN" | "STAFF")}
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="STAFF">Staff</option>
                  </select>
                ) : <span />}
                {member.accessKind === "AGENCY_OWNER" ? (
                  <span className="agencyAccessProtected">Commercial owner</span>
                ) : (
                  <button
                    type="button"
                    className="agencyDangerButton"
                    disabled={busy !== null}
                    onClick={() => void removeMember(member.userId)}
                  >
                    {busy === `member:${member.userId}` ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="agencyAccessSection">
            <h3>Pending invitations</h3>
            {data.invitations.length === 0 && <p className="agencyAccessHint">No pending invitations.</p>}
            {data.invitations.map((invitation) => (
              <div className="agencyAccessRow" key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <span>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</span>
                </div>
                <span className="agencyAccessRole">
                  {invitation.accessKind === "CLIENT_OWNER" ? "Client owner" : invitation.role === "ADMIN" ? "Admin" : "Staff"}
                </span>
                <span />
                <button
                  type="button"
                  className="agencyDangerButton"
                  disabled={busy !== null}
                  onClick={() => void revokeInvitation(invitation.id)}
                >
                  {busy === `invite:${invitation.id}` ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
