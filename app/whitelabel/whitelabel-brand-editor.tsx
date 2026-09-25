"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import { AppNav } from "@/components/core-domain/app-nav";
import type { BrandDraft } from "@/server/whitelabel/brand-schema";

type VersionItem = {
  version: number;
  publishedAt: string;
  publishedByUserId: string | null;
};

type BrandState = {
  brandId: string;
  draft: BrandDraft;
  revision: number;
  publishedVersion: number | null;
  published: BrandDraft | null;
  versions: VersionItem[];
};

type AssetKind = "LOGO" | "ICON" | "FAVICON";
type AssetField = "logoAssetId" | "iconAssetId" | "faviconAssetId";

const EMPTY: BrandDraft = {
  name: "",
  tagline: null,
  primaryColor: "#2563EB",
  accentColor: "#0F172A",
  logoAssetId: null,
  iconAssetId: null,
  faviconAssetId: null,
  supportEmail: null,
  supportUrl: null,
};

function apiMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data) {
    const error = data.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return fallback;
}

function assetUrl(id: string | null) {
  return id ? `/api/whitelabel/brand/assets/${id}` : null;
}

export function WhitelabelBrandEditor() {
  const [state, setState] = useState<BrandState | null>(null);
  const [draft, setDraft] = useState<BrandDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/whitelabel/brand", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "Unable to load Whitelabel brand."));
        if (!cancelled) {
          setState(data);
          setDraft(data.draft);
        }
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load Whitelabel brand."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const dirty = useMemo(() => state ? JSON.stringify(draft) !== JSON.stringify(state.draft) : false, [draft, state]);
  const initials = (draft.name.trim() || "Brand").split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  const theme = {
    "--brand-primary": draft.primaryColor,
    "--brand-accent": draft.accentColor,
  } as CSSProperties;

  function set<K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  async function saveDraft() {
    if (!state) return null;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/brand", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: state.revision, brand: draft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to save brand."));
      setState(data);
      setDraft(data.draft);
      setNotice("Draft saved.");
      return data as BrandState;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save brand.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!state) return;
    let current = state;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return;
      current = saved;
    }
    setBusy("publish");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/brand/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: current.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to publish brand."));
      setState(data);
      setDraft(data.draft);
      setNotice(`Published brand version ${data.publishedVersion}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to publish brand.");
    } finally {
      setBusy(null);
    }
  }

  async function revert(version: number) {
    setBusy(`revert:${version}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/whitelabel/brand/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to restore brand version."));
      setState(data);
      setDraft(data.draft);
      setNotice(`Restored version ${version} as new published version ${data.publishedVersion}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to restore brand version.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(kind: AssetKind, field: AssetField, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(`asset:${kind}`);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const response = await fetch("/api/whitelabel/brand/assets", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "Unable to upload image."));
      set(field, data.asset.id);
      setNotice(`${kind === "LOGO" ? "Logo" : kind === "ICON" ? "App icon" : "Favicon"} uploaded. Save the draft to keep this selection.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to upload image.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="appShell">
      <AppNav active="Whitelabel" />
      <section className="appMain">
        <div className="wlBody">
          <header className="wlHeader">
            <div>
              <p className="wlEyebrow">Agency customization</p>
              <h1>Whitelabel</h1>
              <p>Configure the brand your clients will see. Your own AI Caller control center remains unchanged.</p>
            </div>
            {state?.publishedVersion ? <span className="wlPublishedBadge">Published v{state.publishedVersion}</span> : <span className="wlDraftBadge">Draft only</span>}
          </header>

          {error && <div className="wlError" role="alert">{error}</div>}
          {notice && <div className="wlNotice" role="status">{notice}</div>}

          {loading ? <div className="wlCard">Loading brand settings…</div> : (
            <div className="wlGrid">
              <section className="wlCard wlEditor">
                <div className="wlSectionHeading"><h2>Brand identity</h2><p>One brand applies across your Agency client platform.</p></div>
                <label><span>Brand name</span><input value={draft.name} maxLength={60} onChange={(event) => set("name", event.target.value)} placeholder="Stratos Assist" /></label>
                <label><span>Tagline</span><input value={draft.tagline ?? ""} maxLength={120} onChange={(event) => set("tagline", event.target.value || null)} placeholder="Never miss another customer" /></label>

                <div className="wlAssetGrid">
                  <AssetUpload label="Logo" busy={busy === "asset:LOGO"} src={assetUrl(draft.logoAssetId)} onChange={(event) => void upload("LOGO", "logoAssetId", event)} />
                  <AssetUpload label="App icon" busy={busy === "asset:ICON"} src={assetUrl(draft.iconAssetId)} onChange={(event) => void upload("ICON", "iconAssetId", event)} />
                  <AssetUpload label="Favicon" busy={busy === "asset:FAVICON"} src={assetUrl(draft.faviconAssetId)} onChange={(event) => void upload("FAVICON", "faviconAssetId", event)} />
                </div>

                <div className="wlColorGrid">
                  <label><span>Primary color</span><div className="wlColorInput"><input type="color" value={draft.primaryColor} onChange={(event) => set("primaryColor", event.target.value.toUpperCase())} /><input value={draft.primaryColor} onChange={(event) => set("primaryColor", event.target.value)} maxLength={7} /></div></label>
                  <label><span>Accent color</span><div className="wlColorInput"><input type="color" value={draft.accentColor} onChange={(event) => set("accentColor", event.target.value.toUpperCase())} /><input value={draft.accentColor} onChange={(event) => set("accentColor", event.target.value)} maxLength={7} /></div></label>
                </div>

                <div className="wlSectionHeading wlSupportHeading"><h2>Client support</h2><p>Publish requires at least one support contact.</p></div>
                <label><span>Support email</span><input type="email" value={draft.supportEmail ?? ""} onChange={(event) => set("supportEmail", event.target.value || null)} placeholder="support@yourbrand.com" /></label>
                <label><span>Support URL</span><input type="url" value={draft.supportUrl ?? ""} onChange={(event) => set("supportUrl", event.target.value || null)} placeholder="https://yourbrand.com/support" /></label>

                <div className="wlActions">
                  <button className="wlSecondary" type="button" disabled={!dirty || busy !== null} onClick={() => { if (state) setDraft(state.draft); }}>Discard changes</button>
                  <button className="wlSecondary" type="button" disabled={!dirty || busy !== null} onClick={() => void saveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
                  <button className="wlPrimary" type="button" disabled={busy !== null} onClick={() => void publish()}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
                </div>
              </section>

              <div className="wlSide">
                <section className="wlCard">
                  <div className="wlSectionHeading"><h2>Client preview</h2><p>Preview only. AI Caller itself is not being rebranded.</p></div>
                  <div className="wlPreview" style={theme}>
                    <aside className="wlPreviewNav">
                      <div className="wlPreviewBrand">
                        {draft.logoAssetId ? <img src={assetUrl(draft.logoAssetId) ?? ""} alt="" /> : <span>{initials}</span>}
                        <strong>{draft.name || "Your Brand"}</strong>
                      </div>
                      <nav><b>Dashboard</b><span>Inbox</span><span>Contacts</span><span>Appointments</span><span>AI Agent</span></nav>
                      <small>{draft.supportEmail || draft.supportUrl || "Your support contact"}</small>
                    </aside>
                    <div className="wlPreviewContent">
                      <div className="wlPreviewTop"><span>{draft.tagline || "Your client platform"}</span><i /></div>
                      <div className="wlPreviewHero"><span>Welcome back</span><strong>{draft.name || "Your Brand"}</strong><button type="button">Primary action</button></div>
                      <div className="wlPreviewStats"><span /><span /><span /></div>
                    </div>
                  </div>
                </section>

                <section className="wlCard">
                  <div className="wlSectionHeading"><h2>Publication history</h2><p>Restoring a version creates a new version; history is never rewritten.</p></div>
                  {!state?.versions.length ? <p className="wlEmpty">Nothing published yet.</p> : (
                    <div className="wlVersions">
                      {state.versions.map((version) => (
                        <div key={version.version}>
                          <span><strong>Version {version.version}</strong><small>{new Date(version.publishedAt).toLocaleString()}</small></span>
                          {version.version === state.publishedVersion ? <b>Current</b> : <button type="button" disabled={busy !== null} onClick={() => void revert(version.version)}>{busy === `revert:${version.version}` ? "Restoring…" : "Restore"}</button>}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function AssetUpload({ label, src, busy, onChange }: {
  label: string;
  src: string | null;
  busy: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="wlAsset">
      <span>{label}</span>
      <div>{src ? <img src={src} alt="" /> : <b>No image</b>}</div>
      <small>{busy ? "Optimizing…" : "PNG, JPEG or WebP"}</small>
      <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={onChange} />
    </label>
  );
}
