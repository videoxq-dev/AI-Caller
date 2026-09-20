"use client";

import { useEffect, useState } from "react";
import { showToast } from "@/components/toast";

type Technology = "STANDARD" | "REALTIME";
type Model = "gpt-realtime-2.1" | "gpt-realtime-2.1-mini";
type Settings = { technology: Technology; realtimeModel: Model;
  realtimeConfigured: boolean; canManage: boolean };

function getError(value: unknown) {
  if (value && typeof value === "object" && "error" in value) {
    const detail = value.error as { message?: unknown };
    if (typeof detail.message === "string") return detail.message;
  }
  return "Unable to update voice technology.";
}

export function VoiceTechnologySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [technology, setTechnology] = useState<Technology>("STANDARD");
  const [model, setModel] = useState<Model>("gpt-realtime-2.1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/voice/technology", { cache: "no-store" })
      .then(async response => {
        const data: Settings = await response.json();
        if (!response.ok) throw Error(getError(data));
        if (!live) return;
        setSettings(data);
        setTechnology(data.technology);
        setModel(data.realtimeModel);
      }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/voice/technology", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ technology, realtimeModel: model }),
      });
      const data = await response.json() as Settings;
      if (!response.ok) throw Error(getError(data));
      setSettings(current => current && ({ ...current,
        technology: data.technology, realtimeModel: data.realtimeModel }));
      showToast("Voice technology updated. The change applies to new calls only.", "success");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to update voice technology.";
      setError(message);
      showToast(message, "error");
    } finally { setBusy(false); }
  }

  return <div className="voiceTechSettings">
    <div className="sectionHeading"><div>
      <h2>AI voice technology</h2>
      <p>Choose how your AI receptionist talks with callers. Existing calls keep their current engine.</p>
    </div></div>
    {error && <p role="alert" className="voiceTechError">{error}</p>}
    {!settings ? <p>Loading voice settings…</p> : <>
      <div className="voiceTechCards">
        <label className={technology === "STANDARD" ? "voiceTechOption selected" : "voiceTechOption"}>
          <input type="radio" name="voiceTechnology" checked={technology === "STANDARD"}
            disabled={!settings.canManage || busy} onChange={() => setTechnology("STANDARD")} />
          <span><strong>Standard · Cost-controlled</strong>
            <small>Current Telnyx transcription, text AI and speech synthesis. Turn-based conversations.</small>
            <small>Current managed voice rate: 80 credits per started minute; AI text usage billed separately.</small>
          </span>
        </label>
        <label className={technology === "REALTIME" ? "voiceTechOption selected" : "voiceTechOption"}>
          <input type="radio" name="voiceTechnology" checked={technology === "REALTIME"}
            disabled={!settings.canManage || busy || !settings.realtimeConfigured}
            onChange={() => setTechnology("REALTIME")} />
          <span><strong>Realtime · Natural conversations</strong>
            <small>Streaming speech-to-speech with interruption handling and live business tools.</small>
            <small>Actual OpenAI audio/text tokens plus Telnyx call costs, with a 50% cost markup.</small>
            {!settings.realtimeConfigured && <small>Not configured on this deployment.</small>}
          </span>
        </label>
      </div>
      {technology === "REALTIME" && <label className="voiceTechModel">
        <span>Realtime model</span>
        <select value={model} disabled={!settings.canManage || busy}
          onChange={event => setModel(event.target.value as Model)}>
          <option value="gpt-realtime-2.1">Realtime 2.1 · full</option>
          <option value="gpt-realtime-2.1-mini">Realtime 2.1 Mini · lower token cost</option>
        </select>
        <small>Actual charge depends on speech and tool usage, conversation length and provider rates. 
          A 50% markup corresponds to about a 33.3% gross margin before operating costs.</small>
      </label>}
      <div className="voiceTechFoot">
        <small>Current: {settings.technology === "STANDARD" ? "Standard" : `Realtime (${settings.realtimeModel})`}</small>
        {settings.canManage && <button type="button" disabled={busy || (technology === settings.technology &&
          (technology === "STANDARD" || model === settings.realtimeModel))}
          onClick={() => void save()}>{busy ? "Saving…" : "Save voice technology"}</button>}
      </div>
    </>}
  </div>;
}
