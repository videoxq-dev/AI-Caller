"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppNav } from "@/components/core-domain/app-nav";
import "../../integrations.css";
import "../../../../dashboard/dashboard.css";
import "./templates.css";

type Template = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  footer: string;
  rejectionReason: string | null;
};
type TemplatePage = { items: Template[]; nextCursor: string | null };
type Submission = { id: string; name: string; language: string; category: string; status: string };

const languages = [
  ["en_US", "English (US)"], ["en_GB", "English (UK)"],
  ["es_ES", "Spanish"], ["fr_FR", "French"], ["pt_BR", "Portuguese (Brazil)"],
] as const;

function responseError(response: Response, payload: { error?: { message?: string } } | null) {
  return payload?.error?.message || `Request failed (${response.status}).`;
}

function statusLabel(status: string) {
  return status.toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
}

export default function WhatsAppTemplatesPage() {
  const [items, setItems] = useState<Template[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [language, setLanguage] = useState("en_US");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [samples, setSamples] = useState<string[]>([]);

  const placeholderIds = useMemo(() => [...new Set(
    [...body.matchAll(/{{(\d+)}}/g)].map(match => Number(match[1])),
  )].sort((a, b) => a - b), [body]);

  const load = useCallback(async (cursor?: string) => {
    const url = cursor
      ? `/api/integrations/whatsapp/templates?after=${encodeURIComponent(cursor)}`
      : "/api/integrations/whatsapp/templates";
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json().catch(() => null) as
      | (TemplatePage & { error?: { message?: string } })
      | null;
    if (!response.ok || !data?.items) throw new Error(responseError(response, data));
    setItems(current => cursor
      ? [...current, ...data.items.filter(item => !current.some(row => row.id === item.id))]
      : data.items);
    setNextCursor(data.nextCursor);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void load().catch(err => {
      if (active) setError(err instanceof Error ? err.message : "Unable to load WhatsApp templates.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  async function refresh(cursor?: string) {
    if (busy || submitting) return;
    setBusy(true);
    setError("");
    try { await load(cursor); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to refresh templates."); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/integrations/whatsapp/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), category, language, body: body.trim(), footer: footer.trim(),
          samples: placeholderIds.map(id => samples[id - 1] ?? ""),
        }),
      });
      const data = await response.json().catch(() => null) as
        | { template?: Submission; error?: { message?: string } }
        | null;
      if (!response.ok || !data?.template) throw new Error(responseError(response, data));
      setNotice(`“${data.template.name}” submitted to Meta. Current status: ${statusLabel(data.template.status)}. Refresh to check for approval.`);
      setCreating(false);
      setName(""); setBody(""); setFooter(""); setSamples([]);
      await load();
    } catch (err) {
      setError((err instanceof Error ? err.message : "Unable to submit template.")
        + " If the request timed out, refresh the list before trying again.");
    } finally { setSubmitting(false); }
  }

  const visible = items.filter(item => filter === "ALL" || item.status === filter);
  return <main className="appShell waTemplateShell">
    <AppNav active="Integrations" className="appSidebar" />
    <section className="appWorkspace waTemplateWorkspace">
      <header className="waTemplateTop"><Link href="/integrations?provider=whatsapp">← Integrations</Link><span>WhatsApp</span></header>
      <div className="waTemplateContent">
        <div className="waTemplateHeading"><div>
          <h1>Message templates</h1>
          <p>Create and manage the messages your business can send on WhatsApp.</p>
        </div><div className="waTemplateActions">
          <button type="button" className="waSecondary" disabled={loading || busy || submitting} onClick={() => void refresh()}>
            {busy ? "Refreshing…" : "Refresh status"}
          </button>
          <button type="button" className="waPrimary" onClick={() => { setCreating(value => !value); setError(""); }} disabled={submitting}>
            {creating ? "Close" : "+ New template"}
          </button>
        </div></div>

        {notice && <p className="waNotice" role="status">{notice}</p>}
        {error && <p className="waError" role="alert">{error}</p>}

        {creating && <form className="waTemplateForm" onSubmit={event => void submit(event)}>
          <div className="waFormHeading"><h2>New message template</h2><p>Meta reviews templates before they can be used for business-initiated messages.</p></div>
          <label>Template name<input required maxLength={512} pattern="[a-z][a-z0-9_]*"
            value={name} onChange={event => setName(event.target.value.toLowerCase().replace(/\s+/g, "_"))}
            placeholder="appointment_reminder" />
            <small>Lowercase letters, numbers and underscores.</small>
          </label>
          <div className="waFormGrid">
            <label>Category<select value={category} onChange={event => setCategory(event.target.value as typeof category)}>
              <option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option>
            </select></label>
            <label>Language<select value={language} onChange={event => setLanguage(event.target.value)}>
              {languages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select></label>
          </div>
          <label>Message body<textarea required maxLength={1024} rows={5} value={body}
            onChange={event => setBody(event.target.value)} placeholder="Hi {{1}}, your appointment is confirmed for {{2}}." />
            <small>Use numbered placeholders such as {"{{1}}"} and {"{{2}}"} for changing details.</small>
          </label>
          {placeholderIds.map(id => <label key={id}>Example for {"{{" + id + "}}"}
            <input required maxLength={200} value={samples[id - 1] ?? ""}
              onChange={event => setSamples(current => {
                const next = [...current]; next[id - 1] = event.target.value; return next;
              })} placeholder={id === 1 ? "Ada" : "Thursday at 10 AM"} />
          </label>)}
          <label>Footer <span className="waOptional">(optional)</span>
            <input maxLength={60} value={footer} onChange={event => setFooter(event.target.value)}
              placeholder="Thanks for choosing us!" />
          </label>
          <div className="waFormFooter"><span>Text templates only in this first release.</span>
            <button className="waPrimary" type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit to Meta"}
            </button></div>
        </form>}

        <div className="waListHead"><h2>Templates</h2><label>Show
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="ALL">All statuses</option>
            <option value="APPROVED">Approved</option><option value="PENDING">Pending</option>
            <option value="REJECTED">Rejected</option><option value="PAUSED">Paused</option>
            <option value="DISABLED">Disabled</option>
          </select></label>
        </div>
        {loading ? <p className="waEmpty">Loading templates…</p> : visible.length === 0
          ? <p className="waEmpty">{items.length ? "No templates match this filter." : "No templates found for this WhatsApp account."}</p>
          : <div className="waTemplateList">{visible.map(item => <details key={item.id} className="waTemplateCard">
            <summary><span><strong>{item.name.replace(/_/g, " ")}</strong><small>{item.language.replace("_", "-")} · {statusLabel(item.category)}</small></span>
              <span className={`waStatus waStatus-${item.status.toLowerCase()}`}>{statusLabel(item.status)}</span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="waTemplateDetail"><p>{item.body || "This template includes a non-text message."}</p>
              {item.footer && <small>{item.footer}</small>}
              {item.rejectionReason && <p className="waRejection">Meta rejection reason: {item.rejectionReason}</p>}
              <small>Approval and availability are determined by Meta.</small>
            </div>
          </details>)}</div>}
        {nextCursor && <button className="waLoad" type="button" disabled={busy || submitting}
          onClick={() => void refresh(nextCursor)}>{busy ? "Loading…" : "Load more"}</button>}
      </div>
    </section>
  </main>;
}
