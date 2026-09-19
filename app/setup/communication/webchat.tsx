"use client";

import { useEffect, useState } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  MessageIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import { showToast } from "@/components/toast";

type WidgetConfig = {
  publicKey: string;
  enabled: boolean;
  greeting: string | null;
  launcherLabel: string;
  embedCode: string;
};

export function WebChatSetup() {
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState("Hi! 👋 How can we help you today?");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/widget/config", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to load web chat configuration.");
        return payload as WidgetConfig;
      })
      .then((payload) => {
        if (cancelled) return;
        setConfig(payload);
        if (payload.greeting) setWelcomeMessage(payload.greeting);
      })
      .catch((error) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : "Unable to load web chat configuration.", "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function saveGreeting() {
    setSaving(true);
    try {
      const response = await fetch("/api/widget/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ greeting: welcomeMessage }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save the web chat greeting.");
      setConfig(payload as WidgetConfig);
      showToast("Web chat greeting saved.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to save the web chat greeting.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function copyEmbedCode() {
    if (!config?.embedCode) return;
    try {
      await navigator.clipboard.writeText(config.embedCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      showToast("Your browser blocked clipboard access. Select and copy the embed code manually.", "error");
    }
  }

  return (
    <section className="channelSetupCard webchatSetupCard">
      <div className="communicationSectionHeading">
        <span className="sectionCircle orange"><MessageIcon size={23} /></span>
        <div>
          <h2>Web Chat Setup</h2>
          <p>Add AI Caller&apos;s web chat widget to your website. There is no provider or widget type to choose.</p>
        </div>
      </div>

      <div className="webchatWorkspace">
        <div className="webchatConfigColumn">
          <section className="webchatPanel appearancePanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon">💬</span>
              <div><h3>Welcome message</h3><p>This message is saved to your workspace and shown when a visitor starts a new chat.</p></div>
            </div>
            <label className="communicationField welcomeField">
              <span>Greeting</span>
              <textarea rows={3} maxLength={500} value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} />
              <small className="fieldCounter">{welcomeMessage.length}/500</small>
            </label>
            <button type="button" className="webchatSaveButton" disabled={saving || loading} onClick={() => void saveGreeting()}>{saving ? "Saving..." : "Save greeting"}</button>
          </section>

          <section className="webchatPanel embedPanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon codeIcon">&lt;/&gt;</span>
              <div><h3>Embed on your website</h3><p>Add this code to your website&apos;s HTML just before the closing &lt;/body&gt; tag.</p></div>
            </div>
            <div className="embedCodeBox">
              <pre>{loading ? "Loading your widget code…" : config?.embedCode ?? "Widget code is unavailable."}</pre>
              <button type="button" disabled={!config?.embedCode} onClick={copyEmbedCode}>▣ {copied ? "Copied" : "Copy code"}</button>
            </div>
          </section>
        </div>

        <section className="webchatPanel livePreviewPanel">
          <div className="livePreviewHeading"><h3>Live preview</h3><p>The greeting below uses the same content saved to the real widget.</p></div>
          <div className="widgetPreview rounded">
            <div className="widgetPreviewHeader">
              <span className="widgetPreviewAvatar">AI</span>
              <div><strong>AI Assistant</strong><small><i /> Online</small></div>
              <span className="minimizeWidget">—</span>
            </div>
            <div className="widgetPreviewBody">
              <div className="previewWelcome">{welcomeMessage || "Hi! How can we help you today?"}</div>
            </div>
            <div className="widgetPreviewComposer"><span>Type a message...</span><button type="button">➤</button></div>
            <div className="poweredBy">Powered by <strong>AI Caller</strong></div>
          </div>
        </section>
      </div>
    </section>
  );
}

export function WebChatSidebar() {
  return (
    <section className="sidebarCard communicationWhyCard webchatWhyCard">
      <h2>Why add web chat?</h2>
      <p>Turn website visitors into customers. Your AI assistant can answer questions, capture leads and book appointments while your team is offline.</p>

      <div className="communicationBenefits webchatBenefits">
        <div className="communicationBenefit"><span className="benefitIcon green"><SparkleIcon size={16} /></span><div><strong>Capture more leads</strong><small>Engage visitors before they leave</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon purple"><ClockIcon size={16} /></span><div><strong>Answer instantly</strong><small>Provide 24/7 support</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon blue"><CalendarIcon size={16} /></span><div><strong>Book appointments</strong><small>Let customers book directly in chat</small></div></div>
        <div className="communicationBenefit"><span className="benefitIcon orange"><UsersIcon size={16} /></span><div><strong>Reduce workload</strong><small>Handle common questions automatically</small></div></div>
      </div>

      <div className="editableNote communicationEditableNote webchatInstallNote">
        <span className="infoBubble"><InfoIcon size={18} /></span>
        <div>
          <strong>Install the widget in three steps</strong>
          <p>1. Copy the embed code from the setup card.<br />2. Paste it just before your site&apos;s closing &lt;/body&gt; tag.<br />3. Publish the site and open a test chat.</p>
        </div>
      </div>
    </section>
  );
}
