"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarIcon } from "@/components/icons";
import { AppNav } from "./app-nav";

type Contact = { id: string; name: string | null; email: string | null; phone: string | null };
type Appointment = {
  id: string;
  contactId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  bookingSource: string | null;
  notes: string | null;
};
type AppointmentRow = { appointment: Appointment; contact: Contact };
type AppointmentResponse = { items: AppointmentRow[]; total: number };

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function toLocalInput(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

export function AppointmentsDataPage() {
  const [rows, setRows] = useState<AppointmentRow[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBook, setShowBook] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDraft, setRescheduleDraft] = useState({
    startsAt: "", endsAt: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ contactId: "", title: "Consultation", startsAt: toLocalInput(new Date(Date.now() + 86_400_000)), endsAt: toLocalInput(new Date(Date.now() + 88_200_000)), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: "100" });
    if (status !== "all") params.set("status", status);
    try {
      const [appointmentsResponse, contactsResponse] = await Promise.all([
        fetch(`/api/appointments?${params.toString()}`, { cache: "no-store" }),
        fetch("/api/contacts?limit=100", { cache: "no-store" }),
      ]);
      if (!appointmentsResponse.ok || !contactsResponse.ok) throw new Error("Unable to load appointments.");
      const appointmentData = await appointmentsResponse.json() as AppointmentResponse;
      const contactData = await contactsResponse.json() as { items: Contact[] };
      setRows(appointmentData.items);
      setContacts(contactData.items);
      setDraft((current) => ({ ...current, contactId: current.contactId || contactData.items[0]?.id || "" }));
      if (!selectedId && appointmentData.items[0]) setSelectedId(appointmentData.items[0].appointment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load appointments.");
    } finally {
      setLoading(false);
    }
  }, [selectedId, status]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => rows.find((row) => row.appointment.id === selectedId) ?? null, [rows, selectedId]);
  const todayCount = useMemo(() => rows.filter(({ appointment }) => new Date(appointment.startsAt).toDateString() === new Date().toDateString()).length, [rows]);

  async function book() {
    setError(null);
    const response = await fetch("/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contactId: draft.contactId,
        title: draft.title,
        startsAt: new Date(draft.startsAt).toISOString(),
        endsAt: new Date(draft.endsAt).toISOString(),
        timezone: draft.timezone,
        bookingSource: "DASHBOARD",
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "Unable to book appointment.");
      return;
    }
    setShowBook(false);
    await load();
  }

  async function cancel(appointmentId: string) {
    if (!window.confirm("Cancel this appointment? This will notify the calendar and cannot be undone.")) return;
    setError(null);
    const response = await fetch(`/api/appointments/${appointmentId}/cancel`, { method: "POST" });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "Unable to cancel appointment.");
      return;
    }
    await load();
  }

  function openReschedule(appointment: Appointment) {
    setError(null);
    setShowReschedule(true);
    setRescheduleDraft({
      startsAt: toLocalInput(new Date(appointment.startsAt)),
      endsAt: toLocalInput(new Date(appointment.endsAt)),
    });
  }

  async function reschedule(appointmentId: string) {
    setError(null);
    const startsAt = new Date(rescheduleDraft.startsAt);
    const endsAt = new Date(rescheduleDraft.endsAt);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) ||
      startsAt <= new Date() || endsAt <= startsAt) {
      setError("Choose a future start and an end after the start.");
      return;
    }
    const response = await fetch(`/api/appointments/${appointmentId}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "Unable to reschedule appointment.");
      return;
    }
    setShowReschedule(false);
    await load();
  }

  return (
    <main className="appShell appointmentsShell">
      <AppNav active="Appointments" className="appSidebar appointmentsSidebar" />
      <section className="appWorkspace appointmentsWorkspace">
        <header className="appointmentsTopbar"><div className="appointmentsGlobalSearch"><span>⌕</span><input placeholder="Search appointments, contacts or phone numbers..." readOnly /></div><div className="appointmentsTopActions"><button className="appointmentsAgentStatus" type="button"><i />AI Agent Online</button></div></header>
        <div className={`appointmentsBody ${selected ? "drawerOpen" : ""}`}>
          <div className="appointmentsTitleRow"><h1>Appointments</h1><div className="appointmentsTitleActions"><button className="bookAppointmentButton" type="button" onClick={() => setShowBook((value) => !value)}>＋ Book appointment</button></div></div>
          <div className="appointmentTabs"><button className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>All <span>{rows.length}</span></button><button className={status === "CONFIRMED" ? "active" : ""} onClick={() => setStatus("CONFIRMED")}>Confirmed</button><button className={status === "PENDING" ? "active" : ""} onClick={() => setStatus("PENDING")}>Pending</button><button className={status === "CANCELLED" ? "active" : ""} onClick={() => setStatus("CANCELLED")}>Cancelled</button></div>

          <div className="todaySummary"><div><strong>{rows.length}</strong><span>Loaded</span></div><div><strong>{todayCount}</strong><span>Today</span></div><div><strong>{rows.filter((row) => row.appointment.status === "CONFIRMED").length}</strong><span>Confirmed</span></div><div><strong>{rows.filter((row) => row.appointment.status === "CANCELLED").length}</strong><span>Cancelled</span></div></div>

          {showBook && <section className="appointmentListView" style={{ padding: 16 }}><div className="listViewHeading"><h2>Book appointment</h2></div><div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1.5fr 1.5fr 1.4fr auto", gap: 10 }}>
            <select aria-label="Contact" value={draft.contactId} onChange={(event) => setDraft((current) => ({ ...current, contactId: event.target.value }))}><option value="">Select contact</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name ?? contact.phone ?? contact.email ?? "Unnamed"}</option>)}</select>
            <input aria-label="Title" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
            <input aria-label="Starts at" type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft((current) => ({ ...current, startsAt: event.target.value }))} />
            <input aria-label="Ends at" type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft((current) => ({ ...current, endsAt: event.target.value }))} />
            <input aria-label="Timezone" value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} />
            <button type="button" className="bookAppointmentButton" disabled={!draft.contactId} onClick={() => void book()}>Book</button>
          </div></section>}

          {error && <div className="tabNotice"><strong>Appointment error</strong><span>{error}</span></div>}
          <section className="allAppointmentsSection"><div className="sectionHeadingInline"><h2>Appointments</h2></div><div className="appointmentsTableCard"><div className="appointmentsTableScroll"><table className="appointmentsTable"><thead><tr><th>Date & time</th><th>Contact</th><th>Type</th><th>Status</th><th>Source</th></tr></thead><tbody>
            {rows.map(({ appointment, contact }) => <tr key={appointment.id} className={selectedId === appointment.id ? "selected" : ""} onClick={() => setSelectedId(appointment.id)}><td><strong>{displayDate(appointment.startsAt)}</strong><small>{appointment.timezone}</small></td><td><strong>{contact.name ?? "Unnamed contact"}</strong><small>{contact.phone ?? contact.email ?? "—"}</small></td><td>{appointment.title}</td><td><span className={`appointmentBadge ${appointment.status.toLowerCase()}`}>{appointment.status}</span></td><td>{appointment.bookingSource ?? "—"}</td></tr>)}
            {loading && <tr><td colSpan={5}>Loading appointments…</td></tr>}{!loading && !rows.length && <tr><td colSpan={5}>No appointments yet.</td></tr>}
          </tbody></table></div></div></section>
        </div>

        {selected && <aside className="appointmentDrawer"><div className="drawerHeader"><div><h2>{selected.appointment.title}</h2><span className={`appointmentBadge ${selected.appointment.status.toLowerCase()}`}>{selected.appointment.status}</span></div><button type="button" className="drawerClose" onClick={() => setSelectedId(null)}>×</button></div><section className="drawerSection"><h3>Appointment</h3><div className="drawerDetails"><div><span>Contact</span><strong>{selected.contact.name ?? "Unnamed contact"}</strong></div><div><span>Starts</span><strong>{displayDate(selected.appointment.startsAt)}</strong></div><div><span>Ends</span><strong>{displayDate(selected.appointment.endsAt)}</strong></div><div><span>Timezone</span><strong>{selected.appointment.timezone}</strong></div><div><span>Notes</span><strong>{selected.appointment.notes ?? "—"}</strong></div></div></section><div className="drawerQuickActions">
          {["PENDING", "CONFIRMED"].includes(selected.appointment.status) &&
            <button type="button" onClick={() => showReschedule
              ? setShowReschedule(false) : openReschedule(selected.appointment)}>
              <CalendarIcon size={15} />{showReschedule ? "Close rescheduling" : "Reschedule appointment"}
            </button>}
          {showReschedule && ["PENDING", "CONFIRMED"].includes(selected.appointment.status) &&
            <div className="drawerSection" style={{ display: "grid", gap: 8 }}>
              <strong>Change existing appointment</strong>
              <small>Enter times in your device's timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}). The existing appointment remains unchanged until saved.</small>
              <label>New start <input aria-label="New appointment start" type="datetime-local"
                value={rescheduleDraft.startsAt}
                onChange={event => setRescheduleDraft(previous => {
                  const start = new Date(event.target.value);
                  const duration = new Date(selected.appointment.endsAt).getTime() -
                    new Date(selected.appointment.startsAt).getTime();
                  return {
                    ...previous,
                    startsAt: event.target.value,
                    endsAt: Number.isFinite(start.getTime())
                      ? toLocalInput(new Date(start.getTime() + duration))
                      : previous.endsAt,
                  };
                })} /></label>
              <label>New end <input aria-label="New appointment end" type="datetime-local"
                value={rescheduleDraft.endsAt}
                onChange={event => setRescheduleDraft(previous => ({
                  ...previous, endsAt: event.target.value,
                }))} /></label>
              <button type="button" onClick={() => void reschedule(selected.appointment.id)}>
                Confirm reschedule
              </button>
            </div>}
          {selected.appointment.status !== "CANCELLED" &&
            <button type="button" onClick={() => void cancel(selected.appointment.id)}>
              Cancel appointment
            </button>}
        </div></aside>}
      </section>
    </main>
  );
}
