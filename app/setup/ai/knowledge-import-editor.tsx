"use client";

import { useEffect, useState } from "react";
import { FileIcon, LinkIcon } from "@/components/icons";
import { showToast } from "@/components/toast";

type KnowledgeSource = {
  id: string;
  kind: "WEBSITE" | "FILE";
  label: string;
  sourceUrl: string | null;
  updatedAt: string;
};

export function KnowledgeImportEditor({ initialWebsite }: { initialWebsite: string }) {
  const [website, setWebsite] = useState(initialWebsite);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [sourceLimit, setSourceLimit] = useState<number | null>(null);
  const [busy, setBusy] = useState<"website" | "file" | null>(null);

  useEffect(() => setWebsite(initialWebsite), [initialWebsite]);

  async function refresh() {
    const response = await fetch("/api/knowledge", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to load imported knowledge.");
    const page = Array.isArray(payload?.sources) ? payload.sources as KnowledgeSource[] : [];
    setSources(page);
    setSourceCount(typeof payload?.count === "number" ? payload.count : page.length);
    setSourceLimit(typeof payload?.limit === "number" ? payload.limit : 0);
  }

  useEffect(() => {
    void refresh().catch((error) => showToast(error instanceof Error ? error.message : "Unable to load imported knowledge.", "error"));
  }, []);

  async function importWebsite() {
    if (!website.trim() || busy || sourceLimit !== 2) return;
    setBusy("website");
    try {
      const response = await fetch("/api/knowledge/website", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: website.trim() }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to import website knowledge.");
      await refresh();
      showToast("Website knowledge imported and available to your AI.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to import website knowledge.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function uploadFile(file: File) {
    if (busy || sourceLimit !== 2 || sourceCount >= 2) return;
    setBusy("file");
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/knowledge/files", { method: "POST", body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to upload knowledge file.");
      await refresh();
      showToast(file.name + " is now available to your AI.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to upload knowledge file.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeSource(sourceId: string) {
    try {
      const response = await fetch("/api/knowledge/" + encodeURIComponent(sourceId), { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to remove knowledge source.");
      await refresh();
      showToast("Knowledge source removed.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to remove knowledge source.", "error");
    }
  }

  return (
    <>
      {sourceLimit === null ? (
        <p>Loading imported knowledge…</p>
      ) : sourceLimit === 0 ? (
        <p>Upgrade to Unlimited to import up to two knowledge sources per business.</p>
      ) : (
        <>
        <div className="importGrid">
          <div className="websiteImport">
            <label className="aiField">
              <span>Website URL</span>
              <input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://example.com" />
            </label>
            <button type="button" className="importButton" disabled={busy !== null || !website.trim()} onClick={() => void importWebsite()}>
              <LinkIcon size={16} /> {busy === "website" ? "Importing..." : "Import from website"}
            </button>
          </div>
          <div className="fileUploadBlock">
            <strong>Upload files</strong>
            <label className="uploadDropzone">
              <FileIcon size={20} />
              <span>TXT or MD · max 256 KB</span>
              <span className="chooseFiles">{busy === "file" ? "Uploading..." : sourceCount >= 2 ? "Two-source limit reached" : "Choose file"}</span>
              <input
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                disabled={busy !== null || sourceCount >= 2}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (file) void uploadFile(file).finally(() => { input.value = ""; });
                }}
              />
            </label>
          </div>
        </div>
        </>
      )}

      {sources.length > 0 && (
        <div className="knowledgeSourceList">
          <strong>Imported knowledge ({sourceCount} / {sourceLimit ?? 0})</strong>
          {sources.map((source) => (
            <div className="knowledgeSourceRow" key={source.id}>
              <span className="knowledgeSourceIcon">{source.kind === "WEBSITE" ? <LinkIcon size={14} /> : <FileIcon size={14} />}</span>
              <div>
                <strong>{source.label}</strong>
                <small>{source.kind === "WEBSITE" ? source.sourceUrl : "Uploaded text file"}</small>
              </div>
              <button type="button" onClick={() => void removeSource(source.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
