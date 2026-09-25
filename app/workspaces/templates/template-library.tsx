"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { AgencyTemplateSnapshot } from "@/server/agency/template-schema";
import { AgencyTemplateEditor, blankAgencyTemplate } from "./template-editor";

type TemplateSummary = {
  id: string; name: string; description: string | null; currentVersion: number; updatedAt: string;
};
type AgencyWorkspace = { workspaceId: string; workspaceName: string; workspaceStatus: string };
type SelectedTemplate = {
  id: string | null; version: number | null; currentVersion: number | null;
  name: string; description: string; snapshot: AgencyTemplateSnapshot;
};
const readError = (value: unknown, fallback: string) => {
  if (value && typeof value === "object" && "error" in value) {
    const entry = value.error;
    if (entry && typeof entry === "object" && "message" in entry && typeof entry.message === "string") {
      return entry.message;
    }
  }
  return fallback;
};
const draftTemplate = (): SelectedTemplate => ({
  id: null, version: null, currentVersion: null,
  name: "", description: "", snapshot: blankAgencyTemplate(),
});

function currentReviewWarnings(snapshot: AgencyTemplateSnapshot): string[] {
  const text = JSON.stringify(snapshot);
  const notes: string[] = [];
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) notes.push("Review email addresses.");
  if (/(?:\+?\d[\s().-]?){8,}/.test(text)) notes.push("Review phone numbers and account numbers.");
  if (/https?:\/\//i.test(text)) notes.push("Review external website links.");
  return notes;
}

export function AgencyTemplateLibrary() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<AgencyWorkspace[]>([]);
  const [editing, setEditing] = useState<SelectedTemplate | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      fetch("/api/agency/templates", { cache: "no-store", signal: controller.signal }),
      fetch("/api/agency/workspaces", { cache: "no-store", signal: controller.signal }),
    ]).then(async ([templateResponse, workspaceResponse]) => {
      const [templatePayload, workspacePayload] = await Promise.all([
        templateResponse.json(), workspaceResponse.json(),
      ]);
      if (!templateResponse.ok) throw new Error(readError(templatePayload, "Unable to load templates."));
      if (!workspaceResponse.ok) throw new Error(readError(workspacePayload, "Unable to load Agency workspaces."));
      if (controller.signal.aborted) return;
      setTemplates(templatePayload.templates);
      setWorkspaces(workspacePayload.workspaces);
      setError(null);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load templates.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  function updateDraft(next: SelectedTemplate) {
    setEditing(next);
    setReviewed(false);
    setNotice(null);
  }

  async function extract() {
    if (!sourceId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/agency/templates/preview?sourceWorkspaceId=${encodeURIComponent(sourceId)}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(readError(data, "Unable to extract reusable setup."));
      const source = workspaces.find((workspace) => workspace.workspaceId === sourceId);
      setEditing({
        ...draftTemplate(), name: source ? `${source.workspaceName} template` : "",
        snapshot: data.snapshot,
      });
      setSourceWarnings(data.warnings ?? []);
      setReviewed(false);
      setNotice("Review the extracted details and remove source-business information before publishing.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to extract setup.");
    } finally {
      setBusy(false);
    }
  }

  async function openTemplate(id: string, version?: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const url = `/api/agency/templates/${id}${version ? `?version=${version}` : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(readError(data, "Unable to open template."));
      const template = data.template;
      setEditing({
        id, version: template.version, currentVersion: template.currentVersion,
        name: template.name, description: template.description ?? "",
        snapshot: template.snapshot,
      });
      setSourceWarnings([]);
      setReviewed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to open template.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy || !reviewed || editing.version !== editing.currentVersion) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        name: editing.name.trim(), description: editing.description.trim() || null,
        reviewed: true, snapshot: editing.snapshot,
      };
      const response = await fetch(
        editing.id ? `/api/agency/templates/${editing.id}/versions` : "/api/agency/templates",
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(editing.id
            ? { ...body, expectedVersion: editing.currentVersion } : body),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(readError(data, "Unable to save template."));
      setNotice(editing.id ? "New template version published." : "Template created.");
      setEditing(null);
      setReviewed(false);
      setSourceWarnings([]);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save template.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(template: TemplateSummary) {
    if (busy || !window.confirm(
      `Archive "${template.name}"? Existing client workspaces will not change.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agency/templates/${template.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(readError(data, "Unable to archive template."));
      if (editing?.id === template.id) setEditing(null);
      setNotice("Template archived. Previously created clients are unchanged.");
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to archive template.");
    } finally {
      setBusy(false);
    }
  }

  const oldVersion = editing?.version != null
    && editing.currentVersion != null && editing.version !== editing.currentVersion;
  const warnings = editing ? currentReviewWarnings(editing.snapshot) : [];

  return (
    <main className="agencyBody">
      <div className="agencyTemplateHeader">
        <div>
          <p className="agencyEyebrow">Agency workspace templates</p>
          <h1>Reusable client setups</h1>
          <p>Build once, review reusable business content, then launch independent Core-level client workspaces.</p>
          <Link href="/workspaces" className="agencySecondaryButton">← Back to workspaces</Link>
        </div>
        <button type="button" className="agencyCreateButton" disabled={busy}
          onClick={() => {
            setEditing(draftTemplate()); setSourceWarnings([]); setReviewed(false);
            setNotice(null); setError(null);
          }}>+ Blank template</button>
      </div>

      {error && <div className="agencyActionError" role="alert">{error}</div>}
      {notice && <p className="agencyCreditNotice" role="status">{notice}</p>}

      <section className="agencyListCard agencyTemplateSource" aria-label="Create template from business">
        <div>
          <h2>Create from an existing business</h2>
          <p>Extract reusable setup for review. We do not copy customer records, phone assignments, credentials, credit balances or live status.</p>
        </div>
        <label htmlFor="template-source">Source business</label>
        <select id="template-source" value={sourceId} disabled={busy || loading}
          onChange={(event) => setSourceId(event.target.value)}>
          <option value="">Choose a business</option>
          {workspaces.filter((workspace) => workspace.workspaceStatus === "ACTIVE").map((workspace) => (
            <option value={workspace.workspaceId} key={workspace.workspaceId}>{workspace.workspaceName}</option>
          ))}
        </select>
        <button type="button" className="agencySecondaryButton" disabled={busy || !sourceId}
          onClick={() => void extract()}>{busy ? "Preparing…" : "Review reusable setup"}</button>
      </section>

      <section className="agencyListCard" aria-label="Agency template library">
        <div className="agencyListHeader">
          <div><h2>Your templates</h2><p>Only your Agency can access these reusable configurations.</p></div>
          <span>{templates.length} templates</span>
        </div>
        {loading && <p className="agencyEmpty">Loading templates…</p>}
        {!loading && templates.length === 0 && <p className="agencyEmpty">No templates yet. Create one above.</p>}
        {templates.map((template) => (
          <article className="agencyTemplateListRow" key={template.id}>
            <div>
              <strong>{template.name}</strong>
              <span>{template.description || "Reusable business setup"}</span>
              <small>Version {template.currentVersion} · Updated {new Date(template.updatedAt).toLocaleDateString()}</small>
            </div>
            <div className="agencyTemplateListActions">
              <button type="button" className="agencySecondaryButton" disabled={busy}
                onClick={() => void openTemplate(template.id)}>Review / edit</button>
              <Link className="agencyOpenButton" href={`/workspaces?templateId=${template.id}`}>
                Use template</Link>
              <button type="button" className="agencyDangerButton" disabled={busy}
                onClick={() => void archive(template)}>Archive</button>
            </div>
          </article>
        ))}
      </section>

      {editing && (
        <form className="agencyTemplateForm" onSubmit={(event) => void save(event)}>
          <header className="agencyTemplateFormHeader">
            <div>
              <p className="agencyEyebrow">{editing.id ? "Template revision" : "New reusable template"}</p>
              <h2>{editing.id ? editing.name : "Prepare template"}</h2>
              <p>A published version is permanent. Saving an edit creates a new version; it never modifies an existing client.</p>
            </div>
            <button type="button" className="agencySecondaryButton" disabled={busy}
              onClick={() => { setEditing(null); setReviewed(false); }}>Close editor</button>
          </header>
          {editing.id && (
            <label className="agencyTemplateHistory">View version
              <select value={editing.version ?? 1} disabled={busy}
                onChange={(event) => void openTemplate(editing.id!, Number(event.target.value))}>
                {Array.from({ length: editing.currentVersion ?? 1 }, (_, index) => index + 1)
                  .map((version) => <option key={version} value={version}>Version {version}</option>)}
              </select>
            </label>
          )}
          {oldVersion && <p className="agencyTemplateReviewNote" role="status">
            Viewing an immutable historical version. Select the latest version to publish an update.
          </p>}
          <div className="agencyTemplateFields">
            <label>Template name
              <input required minLength={2} maxLength={120} disabled={busy || oldVersion}
                value={editing.name} onChange={(event) => updateDraft({ ...editing, name: event.target.value })} />
            </label>
            <label>Description
              <input maxLength={400} disabled={busy || oldVersion} value={editing.description}
                onChange={(event) => updateDraft({ ...editing, description: event.target.value })} />
            </label>
          </div>
          <fieldset disabled={busy || oldVersion}>
            <AgencyTemplateEditor value={editing.snapshot}
              onChange={(snapshot) => updateDraft({ ...editing, snapshot })} />
          </fieldset>
          <section className="agencyTemplateReview" aria-label="Template content review">
            <h3>Review before publishing</h3>
            <p>Confirm names, contact details, addresses, website links, pricing, policies and service terms apply to future clients.</p>
            <p>The new AI Agent starts in Draft. Phone/SMS/calendar connections, credits, contacts and staff memberships are never copied.</p>
            {sourceWarnings.map((warning) => <p key={warning} className="agencyTemplateReviewNote">Source preview: {warning}</p>)}
            {warnings.map((warning) => <p key={warning} className="agencyTemplateReviewNote">Current content: {warning}</p>)}
            <label className="agencyTemplateCheckbox">
              <input type="checkbox" checked={reviewed} disabled={busy || oldVersion}
                onChange={(event) => setReviewed(event.target.checked)} />
              I have reviewed this template for client-specific and sensitive information.
            </label>
            <div className="agencyTemplateListActions">
              <button type="submit" className="agencyCreateButton"
                disabled={busy || oldVersion || !reviewed || editing.name.trim().length < 2}>
                {busy ? "Saving…" : editing.id ? "Publish new version" : "Publish template"}
              </button>
              <button type="button" className="agencySecondaryButton" disabled={busy}
                onClick={() => { setEditing(null); setReviewed(false); }}>Cancel</button>
            </div>
          </section>
        </form>
      )}
    </main>
  );
}
