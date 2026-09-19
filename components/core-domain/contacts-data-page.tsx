"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageIcon, PhoneIcon } from "@/components/icons";
import { AppNav } from "./app-nav";
import { ContactSmsConsent } from "./contact-sms-consent";

type Identity = { id: string; channel: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT"; externalId: string };
type Lead = { status: "NEW" | "QUALIFIED" | "BOOKED" | "WON" | "LOST"; intent: string | null; serviceRequested: string | null } | null;
type Appointment = { id: string; title: string; startsAt: string; status: string };
type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  updatedAt: string;
  identities: Identity[];
  tags: string[];
  lead: Lead;
  appointments?: Appointment[];
};

type ContactListResponse = { items: Contact[]; total: number; limit: number; offset: number };

const channelLabels: Record<Identity["channel"], string> = {
  PHONE: "Phone",
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
  WEBCHAT: "Web Chat",
};

function initials(name: string | null) {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function formatRelative(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ContactsDataPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [leadStatus, setLeadStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim()) params.set("query", query.trim());
    if (leadStatus !== "all") params.set("status", leadStatus);
    if (channel !== "all") params.set("channel", channel);
    try {
      const response = await fetch(`/api/contacts?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load contacts.");
      const data = await response.json() as ContactListResponse;
      setContacts(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load contacts.");
    } finally {
      setLoading(false);
    }
  }, [channel, leadStatus, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadContacts(), 200);
    return () => window.clearTimeout(timer);
  }, [loadContacts]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    void fetch(`/api/contacts/${selectedId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load contact details.");
        return response.json() as Promise<{ contact: Contact }>;
      })
      .then((data) => { if (!cancelled) setDetail(data.contact); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const knownTags = useMemo(() => Array.from(new Set(contacts.flatMap((contact) => contact.tags))).sort(), [contacts]);

  async function createContact() {
    setError(null);
    const response = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        email: draft.email,
        phone: draft.phone,
        tags: [],
        identities: draft.phone ? [{ channel: "PHONE", externalId: draft.phone }] : [],
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "Unable to create contact.");
      return;
    }
    const data = await response.json() as { contact: Contact };
    setShowAdd(false);
    setDraft({ name: "", email: "", phone: "" });
    setSelectedId(data.contact.id);
    await loadContacts();
  }

  return (
    <main className="appShell contactsShell">
      <AppNav active="Contacts" className="appSidebar contactsSidebar" />
      <section className="appWorkspace contactsWorkspace">
        <header className="contactsTopbar">
          <label className="globalSearch"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contacts, phone numbers, or names..." /></label>
          <div className="contactsTopActions"><button className="agentStatus" type="button"><i />AI Agent Online</button></div>
        </header>

        <div className={`contactsContentFrame ${detail ? "drawerOpen" : ""}`}>
          <div className="contactsBody">
            <div className="contactsTitleRow"><h1>Contacts</h1><button className="addContactButton" type="button" onClick={() => setShowAdd((value) => !value)}>＋ Add contact</button></div>

            {showAdd && <section className="contactsTableCard" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr)) auto", gap: 10 }}>
                <input aria-label="Name" placeholder="Name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                <input aria-label="Email" placeholder="Email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
                <input aria-label="Phone" placeholder="Phone" value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
                <button type="button" className="addContactButton" onClick={() => void createContact()}>Save</button>
              </div>
            </section>}

            <div className="contactFilters">
              <label className="contactSearch"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contacts..." /></label>
              <select value={leadStatus} onChange={(event) => setLeadStatus(event.target.value)}><option value="all">All lead status</option><option value="NEW">New</option><option value="QUALIFIED">Qualified</option><option value="BOOKED">Booked</option><option value="WON">Won</option><option value="LOST">Lost</option></select>
              <select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="all">All channels</option><option value="WHATSAPP">WhatsApp</option><option value="PHONE">Phone</option><option value="WEBCHAT">Web Chat</option><option value="SMS">SMS</option></select>
              <button type="button" className="clearFilters" onClick={() => { setQuery(""); setLeadStatus("all"); setChannel("all"); }}>Clear filters</button>
            </div>

            {error && <div className="emptyContacts">{error}</div>}
            <section className="contactsTableCard"><div className="contactsTableScroll"><table className="contactsTable">
              <thead><tr><th>Name</th><th>Phone / Email</th><th>Channels</th><th>Lead status</th><th>Last updated</th><th>Tags</th></tr></thead>
              <tbody>
                {!loading && contacts.map((contact) => (
                  <tr key={contact.id} className={selectedId === contact.id ? "activeContactRow" : ""} onClick={() => setSelectedId(contact.id)}>
                    <td><div className="contactIdentity"><span className="contactAvatar blue">{initials(contact.name)}</span><div><strong>{contact.name ?? "Unnamed contact"}</strong><small>{contact.email ?? "No email"}</small></div></div></td>
                    <td className="contactPhone">{contact.phone ?? contact.email ?? "—"}</td>
                    <td><div className="tagList">{contact.identities.slice(0, 3).map((identity) => <span key={identity.id}>{channelLabels[identity.channel]}</span>)}</div></td>
                    <td><span className={`leadBadge ${contact.lead?.status.toLowerCase() ?? "new"}`}>{contact.lead?.status ?? "NEW"}</span></td>
                    <td><div className="interactionCell"><strong>{formatRelative(contact.updatedAt)}</strong></div></td>
                    <td><div className="tagList">{contact.tags.map((tag) => <span key={tag}>{tag}</span>)}{!contact.tags.length && <span>—</span>}</div></td>
                  </tr>
                ))}
                {loading && <tr><td colSpan={6}><div className="emptyContacts">Loading contacts…</div></td></tr>}
                {!loading && !contacts.length && <tr><td colSpan={6}><div className="emptyContacts">No contacts yet. Add the first contact or let a channel create one automatically.</div></td></tr>}
              </tbody>
            </table></div></section>
            <footer className="contactsFooter"><span>Showing {contacts.length} of {total} contacts</span><span>{knownTags.length} tags</span></footer>
          </div>

          {detail && <aside className="contactDrawer">
            <div className="drawerHeader"><div className="drawerIdentity"><span className="drawerAvatar contactAvatar blue">{initials(detail.name)}</span><div><div className="drawerNameRow"><h2>{detail.name ?? "Unnamed contact"}</h2><span className={`leadBadge ${detail.lead?.status.toLowerCase() ?? "new"}`}>{detail.lead?.status ?? "NEW"}</span></div><small>Updated {formatRelative(detail.updatedAt)}</small></div></div><button type="button" className="drawerClose" onClick={() => setSelectedId(null)}>×</button></div>
            <div className="drawerQuickActions"><button type="button"><PhoneIcon size={15} />Call</button><button type="button"><MessageIcon size={15} />Message</button></div>
            <section className="drawerSection"><h3>Contact details</h3><div className="drawerDetails"><div><span>Email</span><strong>{detail.email ?? "—"}</strong></div><div><span>Phone</span><strong>{detail.phone ?? "—"}</strong></div><div><span>Notes</span><strong>{detail.notes ?? "—"}</strong></div></div></section>
            <ContactSmsConsent contactId={detail.id} phone={detail.phone} />
            <section className="drawerSection"><h3>Channel identities</h3><div className="tagList">{detail.identities.map((identity) => <span key={identity.id}>{channelLabels[identity.channel]} · {identity.externalId}</span>)}</div></section>
            <section className="drawerSection"><h3>Lead</h3><div className="drawerDetails"><div><span>Intent</span><strong>{detail.lead?.intent ?? "—"}</strong></div><div><span>Service</span><strong>{detail.lead?.serviceRequested ?? "—"}</strong></div></div></section>
            <section className="drawerSection"><h3>Appointments</h3>{detail.appointments?.length ? detail.appointments.map((appointment) => <div className="drawerAppointmentCard" key={appointment.id}><strong>{appointment.title}</strong><small>{formatRelative(appointment.startsAt)} · {appointment.status}</small></div>) : <p>No appointments yet.</p>}</section>
          </aside>}
        </div>
      </section>
    </main>
  );
}
