"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type WorkflowSummary = {
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  triggerLabel: string;
  actionLabels: string[];
  runCount: number;
  hasUnpublishedChanges: boolean;
};

type Starter = {
  id: "HIGH_VALUE_LEAD_ALERT" | "NEW_APPOINTMENT_ALERT" | "CUSTOMER_BOOKING_CONFIRMATION" | "BLANK";
  title: string;
  meta: string;
};

const starters: Starter[] = [
  { id: "HIGH_VALUE_LEAD_ALERT", title: "High-value lead alert", meta: "Qualified lead · Score 80+" },
  { id: "NEW_APPOINTMENT_ALERT", title: "New appointment alert", meta: "Appointment booked · Notify team" },
  { id: "CUSTOMER_BOOKING_CONFIRMATION", title: "Customer booking confirmation", meta: "Appointment booked · SMS" },
  { id: "BLANK", title: "Start from scratch", meta: "Build your own automation" },
];

function statusLabel(status: WorkflowSummary["status"]) {
  if (status === "ACTIVE") return "Active";
  if (status === "PAUSED") return "Paused";
  return "Draft";
}

export function CustomAutomationHome({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/automations/workflows", { cache: "no-store" });
      const data = await response.json().catch(() => null) as {
        items?: WorkflowSummary[];
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to load automations.");
      setItems(data?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create(starter: Starter["id"]) {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/automations/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starter }),
      });
      const data = await response.json().catch(() => null) as {
        id?: string;
        error?: { message?: string };
      } | null;
      if (!response.ok || !data?.id) {
        throw new Error(data?.error?.message ?? "Unable to create automation.");
      }
      router.push(`/automations/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create automation.");
      setCreating(false);
    }
  }

  return <section className="customAutomationSection">
    <div className="customAutomationHeader">
      <div><h2>Your automations</h2>{items.length > 0 && <span>{items.length}</span>}</div>
      {canManage && <button className="createAutomationButton" onClick={() => setChooserOpen(true)}>+ Create automation</button>}
    </div>

    {error && <p className="automationError" role="alert">{error}</p>}

    {loading && <div className="automationLoading">Loading automations…</div>}
    {!loading && items.length === 0 && (
      <button className="customAutomationEmpty" disabled={!canManage} onClick={() => canManage && setChooserOpen(true)}>
        <strong>Create your first automation</strong>
      </button>
    )}

    {items.length > 0 && <div className="customAutomationList">
      {items.map(item => <button key={item.id} className="customAutomationCard" onClick={() => router.push(`/automations/${item.id}`)}>
        <span className="customAutomationIcon">↳</span>
        <span className="customAutomationCopy">
          <span className="customAutomationNameRow">
            <strong>{item.name}</strong>
            <i className={`customAutomationStatus ${item.status.toLowerCase()}`}>{statusLabel(item.status)}</i>
          </span>
          <small>{item.triggerLabel}{item.actionLabels.length ? ` · ${item.actionLabels.join(" → ")}` : ""}</small>
        </span>
        <span className="customAutomationRuns">{item.runCount} {item.runCount === 1 ? "run" : "runs"}</span>
        <span className="customAutomationArrow">›</span>
      </button>)}
    </div>}

    {chooserOpen && <div className="starterBackdrop" role="presentation" onMouseDown={() => !creating && setChooserOpen(false)}>
      <div className="starterDialog" role="dialog" aria-modal="true" aria-label="Create automation" onMouseDown={event => event.stopPropagation()}>
        <div className="starterDialogHeader"><h2>Create automation</h2><button disabled={creating} onClick={() => setChooserOpen(false)}>×</button></div>
        <div className="starterGrid">
          {starters.map(starter => <button key={starter.id} disabled={creating} onClick={() => void create(starter.id)}>
            <strong>{starter.title}</strong>
            <span>{starter.meta}</span>
          </button>)}
        </div>
      </div>
    </div>}
  </section>;
}
