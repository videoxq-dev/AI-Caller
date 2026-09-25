"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AppNav } from "@/components/core-domain/app-nav";
import { WorkspaceAccessPanel, type ManagedAgencyWorkspace } from "./workspace-access-panel";

type AgencyWorkspace = ManagedAgencyWorkspace;

type AgencyCapacity = {
  ownedBusinesses: number;
  businessLimit: number;
  availableBusinesses: number;
  agencyClientLimit: number;
  agencyClientsUsed: number;
  agencyClientsAvailable: number;
};

type AgencyDashboardData = {
  workspaces: AgencyWorkspace[];
  originalWorkspaceId: string | null;
  activeWorkspaceId: string | null;
  capacity: AgencyCapacity;
};

function errorMessage(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return fallback;
}

export function AgencyWorkspacesDashboard() {
  const [data, setData] = useState<AgencyDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [accessWorkspace, setAccessWorkspace] = useState<AgencyWorkspace | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch("/api/agency/workspaces", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorMessage(payload, "Unable to load workspaces."));
        setData(payload as AgencyDashboardData);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Unable to load workspaces.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || !data || data.capacity.agencyClientsAvailable <= 0 || newName.trim().length < 2) return;
    setCreating(true);
    setActionError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(errorMessage(payload, "Unable to create workspace."));
      }
      // Existing workspace provisioning selects the new workspace and takes
      // the owner through its business setup. Do not create a parallel flow.
      window.location.assign("/setup/business");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Unable to create workspace.");
      setCreating(false);
    }
  }

  async function openWorkspace(workspaceId: string) {
    if (!data || switchingId || workspaceId === data.activeWorkspaceId) return;
    setSwitchingId(workspaceId);
    setActionError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(errorMessage(payload, "Unable to open workspace."));
      }
      window.location.assign("/dashboard");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Unable to open workspace.");
      setSwitchingId(null);
    }
  }

  const capacity = data?.capacity;
  const atCapacity = capacity !== undefined && capacity.agencyClientsAvailable <= 0;
  const percent = capacity ? Math.min(100, Math.round((capacity.agencyClientsUsed / capacity.agencyClientLimit) * 100)) : 0;

  return (
    <main className="appShell">
      <AppNav active="Workspaces" />
      <section className="appWorkspace">
        <header className="appTopbar">
          <div>
            <h1>Workspaces</h1>
            <span className="dashboardLiveLabel">Manage your Agency client businesses</span>
          </div>
          <button
            type="button"
            className="agencyCreateButton"
            disabled={loading || !capacity || atCapacity}
            onClick={() => { setCreateOpen((value) => !value); setActionError(null); }}
          >
            + New workspace
          </button>
        </header>
        <div className="agencyBody">
          {error && (
            <div className="dashboardError" role="alert">
              <strong>Workspaces unavailable</strong><span>{error}</span>
              <button type="button" onClick={() => setReloadKey((value) => value + 1)}>Try again</button>
            </div>
          )}
          {actionError && <div className="agencyActionError" role="alert">{actionError}</div>}
          <section className="agencySummary" aria-label="Agency workspace capacity" aria-busy={loading}>
            <article className="agencyUsageCard">
              <p className="agencyEyebrow">Client workspace capacity</p>
              <div className="agencyUsageNumber">
                <strong>{capacity?.agencyClientsUsed ?? "—"}<span> / {capacity?.agencyClientLimit ?? "—"}</span></strong>
                <span>client workspaces used</span>
              </div>
              <div className="agencyProgress" role="progressbar"
                aria-label="Client workspace usage" aria-valuenow={capacity?.agencyClientsUsed ?? 0}
                aria-valuemin={0} aria-valuemax={capacity?.agencyClientLimit ?? 50}>
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="agencyUsageHint">
                Your original business is included separately and does not use a client slot.
              </p>
            </article>
            <article className="agencyStatCard">
              <span>Client slots remaining</span>
              <strong>{capacity?.agencyClientsAvailable ?? "—"}</strong>
              <p>{atCapacity ? "Your Agency package is at capacity." : "Available for additional client businesses."}</p>
            </article>
            <article className="agencyStatCard">
              <span>Total owned workspaces</span>
              <strong>{capacity?.ownedBusinesses ?? "—"}</strong>
              <p>Original business plus your client workspaces.</p>
            </article>
          </section>

          {createOpen && (
            <form className="agencyCreateCard" onSubmit={(event) => void createWorkspace(event)}>
              <div>
                <h2>Create a client workspace</h2>
                <p>Give the business a recognizable name. You can configure it after creation.</p>
              </div>
              <label htmlFor="agency-workspace-name">Business name</label>
              <div className="agencyCreateFields">
                <input id="agency-workspace-name" autoFocus minLength={2} maxLength={120}
                  placeholder="e.g. Northside Dental"
                  value={newName} disabled={creating || atCapacity}
                  onChange={(event) => setNewName(event.target.value)} />
                <button type="button" className="agencySecondaryButton" disabled={creating}
                  onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" className="agencyCreateButton" disabled={creating || atCapacity || newName.trim().length < 2}>
                  {creating ? "Creating…" : "Create workspace"}
                </button>
              </div>
            </form>
          )}

          <section className="agencyListCard" aria-label="Owned workspaces">
            <div className="agencyListHeader">
              <div>
                <h2>Your workspaces</h2>
                <p>Open a business here, or use the quick workspace switcher in the sidebar.</p>
              </div>
              <span>{data?.workspaces.length ?? 0} total</span>
            </div>
            {loading && <p className="agencyEmpty">Loading workspaces…</p>}
            {!loading && data?.workspaces.length === 0 && (
              <p className="agencyEmpty">No owned workspaces are available.</p>
            )}
            {data?.workspaces.map((workspace) => {
              const original = workspace.workspaceId === data.originalWorkspaceId;
              const active = workspace.workspaceId === data.activeWorkspaceId;
              const suspended = workspace.workspaceStatus === "SUSPENDED";
              return (
                <article className="agencyWorkspaceRow" key={workspace.workspaceId}>
                  <span className="agencyWorkspaceMark" aria-hidden>{workspace.workspaceName.slice(0, 1).toUpperCase()}</span>
                  <div className="agencyWorkspaceInfo">
                    <strong>{workspace.workspaceName}</strong>
                    <div className="agencyWorkspaceTags">
                      {original && <span className="agencyOriginalTag">Original business</span>}
                      {!original && <span>Client workspace</span>}
                      <span className={suspended ? "agencySuspendedTag" : "agencyActiveTag"}>
                        {suspended ? "Suspended" : "Active"}
                      </span>
                      {active && <span className="agencyCurrentTag">Current workspace</span>}
                    </div>
                  </div>
                  <div className="agencyWorkspaceActions">
                    <button type="button" className="agencySecondaryButton"
                      disabled={suspended}
                      onClick={() => { setAccessWorkspace(workspace); setActionError(null); }}>
                      Manage access
                    </button>
                    <button type="button" className="agencyOpenButton"
                      disabled={suspended || active || switchingId !== null}
                      onClick={() => void openWorkspace(workspace.workspaceId)}>
                      {active ? "Current" : switchingId === workspace.workspaceId ? "Opening…" : "Open workspace"}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>

          {accessWorkspace && (
            <WorkspaceAccessPanel
              workspace={accessWorkspace}
              onClose={() => setAccessWorkspace(null)}
            />
          )}
        </div>
      </section>
    </main>
  );
}
