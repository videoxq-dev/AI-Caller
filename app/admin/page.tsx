"use client";

import { useEffect, useMemo, useState } from "react";
import "./admin.css";
import type { HostedPricingUnit } from "@/server/billing/pricing";

type AdminTab = "overview" | "users" | "workspaces" | "plans" | "rates" | "audit";

type Overview = {
  users: number;
  workspaces: number;
  paidTopups: number;
  topupRevenueCents: number;
  hostedCreditsCharged: number;
  hostedProviderCostMicros: number;
};

type AdminUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  status: "ACTIVE" | "SUSPENDED";
  suspensionReason: string | null;
  platformAdminActive: boolean;
  ownedWorkspaces: number;
  workspaceMemberships: number;
};

type AdminWorkspace = {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  planId: "PERSONAL" | "GROWTH";
  planName: string;
  creditBalance: number;
  memberCount: number;
  pendingInvitations: number;
};

type AdminPlan = {
  id: "PERSONAL" | "GROWTH";
  name: string;
  description: string | null;
  active: boolean;
  subUserLimit: number;
};

type AdminRate = {
  id: string;
  capability: "AI_TEXT" | "SMS" | "VOICE";
  provider: string;
  model: string;
  unit: HostedPricingUnit;
  costMicros: number;
  unitsPerCost: number;
  targetMarginBps: number;
  enabled: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type AuditRow = {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  createdAt: string;
};

function n(value: number) {
  return new Intl.NumberFormat().format(value);
}

function moneyFromCents(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value / 100);
}

function moneyFromMicros(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(value / 1_000_000);
}

function date(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return body as T;
}

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [rates, setRates] = useState<AdminRate[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [newUser, setNewUser] = useState({ name: "", email: "" });
  const [newRate, setNewRate] = useState({
    capability: "AI_TEXT" as "AI_TEXT" | "SMS" | "VOICE",
    provider: "openai",
    model: "gpt-5.6-luna",
    unit: "AI_INPUT_TOKEN" as AdminRate["unit"],
    costMicros: "200000",
    unitsPerCost: "1000000",
    targetMarginBps: "5000",
    effectiveFrom: new Date().toISOString().slice(0, 16),
  });

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [o, u, w, p, r, a] = await Promise.all([
        api<Overview>("/api/admin/overview"),
        api<{ items: AdminUser[] }>("/api/admin/users?limit=200"),
        api<{ items: AdminWorkspace[] }>("/api/admin/workspaces?limit=200"),
        api<{ items: AdminPlan[] }>("/api/admin/plans"),
        api<{ items: AdminRate[] }>("/api/admin/rates"),
        api<{ items: AuditRow[] }>("/api/admin/audit?limit=200"),
      ]);
      setOverview(o);
      setUsers(u.items);
      setWorkspaces(w.items);
      setPlans(p.items);
      setRates(r.items);
      setAuditRows(a.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load platform admin.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  const visibleUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return q ? users.filter((user) => user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q)) : users;
  }, [users, userSearch]);

  const visibleWorkspaces = useMemo(() => {
    const q = workspaceSearch.trim().toLowerCase();
    return q ? workspaces.filter((workspace) => workspace.name.toLowerCase().includes(q)) : workspaces;
  }, [workspaces, workspaceSearch]);

  async function run(action: () => Promise<void>) {
    if (actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      await action();
      await loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Admin action failed.");
    } finally {
      setActionPending(false);
    }
  }

  async function createUser() {
    const name = newUser.name.trim();
    const email = newUser.email.trim();
    if (!name || !email) return;
    await run(async () => {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      setNewUser({ name: "", email: "" });
    });
  }

  async function updateUser(userId: string, patch: Record<string, unknown>) {
    await run(async () => {
      await api(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    });
  }

  async function deleteUser(user: AdminUser) {
    if (user.ownedWorkspaces > 0) {
      setError("Delete or transfer the user's owned workspaces before deleting this account.");
      return;
    }
    if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    await run(async () => {
      await api(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOwnedWorkspaces: false }),
      });
    });
  }

  async function updateWorkspace(workspaceId: string, patch: Record<string, unknown>) {
    await run(async () => {
      await api(`/api/admin/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    });
  }

  async function adjustCredits(workspaceId: string) {
    const raw = window.prompt("Credit adjustment. Use a negative number to remove credits.");
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount === 0) {
      setError("Credit adjustment must be a non-zero integer.");
      return;
    }
    const reason = window.prompt("Reason for this credit adjustment:");
    if (!reason?.trim()) return;
    await run(async () => {
      await api(`/api/admin/workspaces/${workspaceId}/credits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, reason }),
      });
    });
  }

  async function savePlan(plan: AdminPlan) {
    await run(async () => {
      await api(`/api/admin/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: plan.name,
          description: plan.description,
          active: plan.active,
          subUserLimit: plan.subUserLimit,
        }),
      });
    });
  }

  async function createRate() {
    const payload = {
      capability: newRate.capability,
      provider: newRate.provider.trim(),
      model: newRate.model.trim(),
      unit: newRate.unit,
      costMicros: Number(newRate.costMicros),
      unitsPerCost: Number(newRate.unitsPerCost),
      targetMarginBps: Number(newRate.targetMarginBps),
      effectiveFrom: new Date(newRate.effectiveFrom).toISOString(),
    };
    await run(async () => {
      await api("/api/admin/rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });
  }

  async function setRateEnabled(rate: AdminRate, enabled: boolean) {
    await run(async () => {
      await api(`/api/admin/rates/${rate.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    });
  }

  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "users", label: "Users" },
    { id: "workspaces", label: "Workspaces" },
    { id: "plans", label: "Plans" },
    { id: "rates", label: "Hosted API pricing" },
    { id: "audit", label: "Audit log" },
  ];

  return (
    <main className="adminShell">
      <aside className="adminSidebar">
        <a className="adminBrand" href="/dashboard"><span>AI</span><div><strong>AI Caller</strong><small>Platform Admin</small></div></a>
        <nav aria-label="Admin navigation">
          {tabs.map((item) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} type="button">
              {item.label}
            </button>
          ))}
        </nav>
        <a className="adminBack" href="/dashboard">← Customer app</a>
      </aside>

      <section className="adminWorkspace">
        <header className="adminTopbar">
          <div><span>Platform control plane</span><h1>{tabs.find((item) => item.id === tab)?.label}</h1></div>
          <button type="button" onClick={() => void loadAll()} disabled={loading || actionPending}>{loading ? "Loading…" : "Refresh"}</button>
        </header>

        <div className="adminBody">
          {error && <div className="adminError" role="alert"><strong>Admin action unavailable</strong><span>{error}</span></div>}

          {tab === "overview" && (
            <>
              <section className="adminMetricGrid" aria-busy={loading}>
                <Metric label="Users" value={n(overview?.users ?? 0)} />
                <Metric label="Workspaces" value={n(overview?.workspaces ?? 0)} />
                <Metric label="Paid top-ups" value={n(overview?.paidTopups ?? 0)} />
                <Metric label="Net top-up revenue" value={moneyFromCents(overview?.topupRevenueCents ?? 0)} />
                <Metric label="Hosted credits charged" value={n(overview?.hostedCreditsCharged ?? 0)} />
                <Metric label="Recorded provider COGS" value={moneyFromMicros(overview?.hostedProviderCostMicros ?? 0)} />
              </section>
              <section className="adminPanel">
                <div className="adminPanelHeading"><div><h2>Operations</h2><p>Billing and entitlement controls are enforced server-side and every mutation is audited.</p></div></div>
                <div className="adminOpsGrid">
                  <button type="button" onClick={() => setTab("users")}><strong>Manage users</strong><span>Create, suspend, grant admin access or delete safe accounts.</span></button>
                  <button type="button" onClick={() => setTab("workspaces")}><strong>Manage workspaces</strong><span>Change plan/status and make audited credit adjustments.</span></button>
                  <button type="button" onClick={() => setTab("rates")}><strong>Manage pricing</strong><span>Create effective-dated Hosted API price versions.</span></button>
                  <button type="button" onClick={() => setTab("audit")}><strong>Review audit log</strong><span>Trace platform-level administrative mutations.</span></button>
                </div>
              </section>
            </>
          )}

          {tab === "users" && (
            <section className="adminPanel">
              <div className="adminPanelHeading">
                <div><h2>Users</h2><p>{users.length} loaded accounts</p></div>
                <input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Search name or email" />
              </div>
              <div className="adminCreateRow">
                <input value={newUser.name} onChange={(event) => setNewUser((value) => ({ ...value, name: event.target.value }))} placeholder="Full name" />
                <input value={newUser.email} onChange={(event) => setNewUser((value) => ({ ...value, email: event.target.value }))} placeholder="Email" type="email" />
                <button type="button" onClick={() => void createUser()} disabled={actionPending || !newUser.name.trim() || !newUser.email.trim()}>Create user</button>
              </div>
              <div className="adminTableWrap">
                <table className="adminTable usersTable">
                  <thead><tr><th>User</th><th>Status</th><th>Memberships</th><th>Platform admin</th><th>Created</th><th>Actions</th></tr></thead>
                  <tbody>
                    {visibleUsers.map((user) => (
                      <tr key={user.id}>
                        <td><strong>{user.name}</strong><small>{user.email}</small></td>
                        <td><span className={`adminStatus ${user.status.toLowerCase()}`}>{user.status}</span>{user.suspensionReason && <small>{user.suspensionReason}</small>}</td>
                        <td>{user.workspaceMemberships} total / {user.ownedWorkspaces} owned</td>
                        <td><button className={`miniToggle ${user.platformAdminActive ? "on" : ""}`} type="button" disabled={actionPending} onClick={() => void updateUser(user.id, { platformAdmin: !user.platformAdminActive })}>{user.platformAdminActive ? "Admin" : "User"}</button></td>
                        <td>{date(user.createdAt)}</td>
                        <td><div className="rowActions">
                          <button type="button" disabled={actionPending} onClick={() => void updateUser(user.id, user.status === "ACTIVE" ? { status: "SUSPENDED", suspensionReason: "Suspended by platform admin" } : { status: "ACTIVE" })}>{user.status === "ACTIVE" ? "Suspend" : "Reactivate"}</button>
                          <button type="button" className="danger" disabled={actionPending || user.ownedWorkspaces > 0} onClick={() => void deleteUser(user)}>Delete</button>
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === "workspaces" && (
            <section className="adminPanel">
              <div className="adminPanelHeading">
                <div><h2>Workspaces</h2><p>{workspaces.length} loaded workspaces</p></div>
                <input value={workspaceSearch} onChange={(event) => setWorkspaceSearch(event.target.value)} placeholder="Search workspace" />
              </div>
              <div className="adminTableWrap">
                <table className="adminTable workspaceTable">
                  <thead><tr><th>Workspace</th><th>Plan</th><th>Status</th><th>Members</th><th>Credits</th><th>Actions</th></tr></thead>
                  <tbody>
                    {visibleWorkspaces.map((workspace) => (
                      <tr key={workspace.id}>
                        <td><strong>{workspace.name}</strong><small>{workspace.id}</small></td>
                        <td><select value={workspace.planId} disabled={actionPending} onChange={(event) => void updateWorkspace(workspace.id, { planId: event.target.value })}><option value="PERSONAL">Personal</option><option value="GROWTH">Growth</option></select></td>
                        <td><select value={workspace.status} disabled={actionPending} onChange={(event) => void updateWorkspace(workspace.id, { status: event.target.value })}><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></td>
                        <td>{workspace.memberCount} members<small>{workspace.pendingInvitations} pending invitations</small></td>
                        <td><strong>{n(workspace.creditBalance)}</strong></td>
                        <td><button type="button" disabled={actionPending} onClick={() => void adjustCredits(workspace.id)}>Adjust credits</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === "plans" && (
            <section className="adminPlanGrid">
              {plans.map((plan) => (
                <article className="adminPanel adminPlanCard" key={plan.id}>
                  <div className="adminPanelHeading"><div><h2>{plan.id}</h2><p>Workspace entitlement plan</p></div><span className={`adminStatus ${plan.active ? "active" : "suspended"}`}>{plan.active ? "ACTIVE" : "INACTIVE"}</span></div>
                  <label><span>Name</span><input value={plan.name} onChange={(event) => setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, name: event.target.value } : item))} /></label>
                  <label><span>Description</span><textarea value={plan.description ?? ""} onChange={(event) => setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, description: event.target.value } : item))} /></label>
                  <label><span>Sub-user limit</span><input type="number" min={0} max={100} value={plan.subUserLimit} onChange={(event) => setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, subUserLimit: Number(event.target.value) } : item))} /></label>
                  <label className="adminCheck"><input type="checkbox" checked={plan.active} onChange={(event) => setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, active: event.target.checked } : item))} /><span>Plan active</span></label>
                  <button type="button" className="adminPrimary" disabled={actionPending} onClick={() => void savePlan(plan)}>Save plan</button>
                </article>
              ))}
            </section>
          )}

          {tab === "rates" && (
            <>
              <section className="adminPanel">
                <div className="adminPanelHeading"><div><h2>Create rate version</h2><p>Existing versions are never overwritten; the prior active interval is closed automatically.</p></div></div>
                <div className="rateForm">
                  <label><span>Capability</span><select value={newRate.capability} onChange={(event) => {
                    const capability = event.target.value as "AI_TEXT" | "SMS" | "VOICE";
                    setNewRate((value) => ({
                      ...value,
                      capability,
                      unit: capability === "SMS" ? "SMS_SEGMENT" : capability === "VOICE" ? "VOICE_MINUTE" : "AI_INPUT_TOKEN",
                      provider: capability === "AI_TEXT" ? "openai" : "telnyx",
                      model: capability === "AI_TEXT" ? value.model || "gpt-5.6-luna" : "",
                      unitsPerCost: capability === "AI_TEXT" ? "1000000" : "1",
                    }));
                  }}><option value="AI_TEXT">AI text</option><option value="SMS">SMS</option><option value="VOICE">Voice</option></select></label>
                  <label><span>Provider</span><input value={newRate.provider} onChange={(event) => setNewRate((value) => ({ ...value, provider: event.target.value }))} /></label>
                  <label><span>Model / market</span><input value={newRate.model} disabled={newRate.capability !== "AI_TEXT" && !newRate.unit.startsWith("VOICE_REALTIME_")} onChange={(event) => setNewRate((value) => ({ ...value, model: event.target.value }))} /></label>
                  <label><span>Unit</span><select value={newRate.unit} onChange={(event) => setNewRate((value) => {
                    const unit = event.target.value as AdminRate["unit"];
                    const realtime = unit.startsWith("VOICE_REALTIME_");
                    const token = unit.endsWith("_TOKEN");
                    return {
                      ...value, unit,
                      ...(realtime ? {
                        provider: token ? "openai" : "telnyx",
                        model: token ? "gpt-realtime-2.1" : "realtime-us-local",
                        unitsPerCost: token ? "1000000" : "1",
                        targetMarginBps: "0",
                      } : unit === "VOICE_MINUTE" ? {
                        provider: "telnyx", model: "", unitsPerCost: "1", targetMarginBps: "5000",
                      } : {}),
                    };
                  })}>{newRate.capability === "SMS" ? <option value="SMS_SEGMENT">SMS segment</option> : newRate.capability === "VOICE" ? <>
                    <option value="VOICE_MINUTE">Legacy voice minute</option>
                    <option value="VOICE_REALTIME_AUDIO_INPUT_TOKEN">Realtime audio input token</option>
                    <option value="VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN">Realtime audio cached input token</option>
                    <option value="VOICE_REALTIME_AUDIO_OUTPUT_TOKEN">Realtime audio output token</option>
                    <option value="VOICE_REALTIME_TEXT_INPUT_TOKEN">Realtime text input token</option>
                    <option value="VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN">Realtime text cached input token</option>
                    <option value="VOICE_REALTIME_TEXT_OUTPUT_TOKEN">Realtime text output token</option>
                    <option value="VOICE_REALTIME_CARRIER_MINUTE">Realtime US local carrier minute</option>
                    <option value="VOICE_REALTIME_STREAM_MINUTE">Realtime media-streaming minute</option>
                    <option value="VOICE_REALTIME_RECORDING_MINUTE">Realtime recording minute</option>
                    <option value="VOICE_REALTIME_TRANSCRIPTION_MINUTE">Realtime Telnyx STT minute</option>
                    <option value="VOICE_REALTIME_GREETING_TTS_CHAR">Realtime greeting TTS character</option>
                  </> : <><option value="AI_INPUT_TOKEN">AI input token</option><option value="AI_CACHED_INPUT_TOKEN">AI cached input token</option><option value="AI_OUTPUT_TOKEN">AI output token</option></>}</select></label>
                  <label><span>Provider cost (micro-USD)</span><input type="number" value={newRate.costMicros} onChange={(event) => setNewRate((value) => ({ ...value, costMicros: event.target.value }))} /></label>
                  <label><span>Units per cost</span><input type="number" value={newRate.unitsPerCost} onChange={(event) => setNewRate((value) => ({ ...value, unitsPerCost: event.target.value }))} /></label>
                  <label><span>Margin (bps; Realtime provider rates: 0)</span><input type="number" value={newRate.targetMarginBps} disabled={newRate.unit.startsWith("VOICE_REALTIME_")} onChange={(event) => setNewRate((value) => ({ ...value, targetMarginBps: event.target.value }))} /></label>
                  <label><span>Effective from</span><input type="datetime-local" value={newRate.effectiveFrom} onChange={(event) => setNewRate((value) => ({ ...value, effectiveFrom: event.target.value }))} /></label>
                </div>
                <button type="button" className="adminPrimary" disabled={actionPending} onClick={() => void createRate()}>Create rate version</button>
              </section>

              <section className="adminPanel">
                <div className="adminPanelHeading"><div><h2>Rate history</h2><p>{rates.length} versions</p></div></div>
                <div className="adminTableWrap">
                  <table className="adminTable ratesTable">
                    <thead><tr><th>Capability</th><th>Provider / model</th><th>Unit</th><th>Provider cost</th><th>Margin</th><th>Effective interval</th><th>Status</th></tr></thead>
                    <tbody>
                      {rates.map((rate) => (
                        <tr key={rate.id}>
                          <td>{rate.capability}</td>
                          <td><strong>{rate.provider}</strong><small>{rate.model || "default"}</small></td>
                          <td>{rate.unit}</td>
                          <td>{n(rate.costMicros)} μUSD / {n(rate.unitsPerCost)}</td>
                          <td>{rate.unit.startsWith("VOICE_REALTIME_") ? "50% markup on total cost" : `${(rate.targetMarginBps / 100).toFixed(2)}% margin`}</td>
                          <td>{date(rate.effectiveFrom)}<small>{rate.effectiveTo ? `to ${date(rate.effectiveTo)}` : "current interval"}</small></td>
                          <td><button type="button" className={`miniToggle ${rate.enabled ? "on" : ""}`} disabled={actionPending} onClick={() => void setRateEnabled(rate, !rate.enabled)}>{rate.enabled ? "Enabled" : "Disabled"}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {tab === "audit" && (
            <section className="adminPanel">
              <div className="adminPanelHeading"><div><h2>Audit log</h2><p>Most recent platform administrative mutations.</p></div></div>
              <div className="adminTableWrap">
                <table className="adminTable auditTable">
                  <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
                  <tbody>{auditRows.map((row) => <tr key={row.id}><td>{date(row.createdAt)}</td><td>{row.actorEmail ?? "Deleted user"}</td><td><strong>{row.action}</strong></td><td>{row.targetType}<small>{row.targetId}</small></td><td><code>{JSON.stringify(row.details)}</code></td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <article className="adminMetric"><span>{label}</span><strong>{value}</strong></article>;
}
