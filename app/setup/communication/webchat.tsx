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
  id: string;
  publicKey: string;
  name: string;
  isPrimary: boolean;
  enabled: boolean;
  greeting: string | null;
  launcherLabel: string;
  embedCode: string;
};

export function WebChatSetup() {
  const [widgets, setWidgets] = useState<WidgetConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unlimitedWidgets, setUnlimitedWidgets] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState("Hi! 👋 How can we help you today?");
  const [widgetName, setWidgetName] = useState("Website chat");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const selected = widgets.find((widget) => widget.id === selectedId) ?? widgets[0] ?? null;
  const selectedPlanAvailable = Boolean(selected && (selected.isPrimary || unlimitedWidgets));

  useEffect(() => {
    let cancelled = false;
    fetch("/api/widgets", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to load web chat configuration.");
        return payload as { widgets: WidgetConfig[]; entitlements?: { unlimitedWidgets?: boolean } };
      })
      .then((payload) => {
        if (cancelled) return;
        setWidgets(payload.widgets);
        setUnlimitedWidgets(payload.entitlements?.unlimitedWidgets === true);
        setSelectedId((current) => current ?? payload.widgets[0]?.id ?? null);
      })
      .catch((error) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : "Unable to load web chat configuration.", "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    setWidgetName(selected.name);
    setWelcomeMessage(selected.greeting ?? "Hi! 👋 How can we help you today?");
  }, [selected?.id]);

  function replaceWidget(updated: WidgetConfig) {
    setWidgets((current) => current.map((widget) => widget.id === updated.id ? updated : widget));
  }

  async function saveWidget() {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/widgets/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: widgetName, greeting: welcomeMessage }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save the web chat widget.");
      replaceWidget(payload.widget as WidgetConfig);
      showToast("Web chat widget saved.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to save the web chat widget.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function createWidget() {
    if (!unlimitedWidgets) return;
    setCreating(true);
    try {
      const response = await fetch("/api/widgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Website chat ${widgets.length + 1}` }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to create another website widget.");
      const created = payload.widget as WidgetConfig;
      setWidgets((current) => [...current, created]);
      setSelectedId(created.id);
      showToast("Website widget created.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to create another website widget.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function toggleWidget() {
    if (!selected) return;
    if (!selectedPlanAvailable && !selected.enabled) {
      showToast("Unlimited is required to re-enable this additional website widget.", "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/widgets/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !selected.enabled }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to update widget status.");
      const updated = payload.widget as WidgetConfig;
      replaceWidget(updated);
      showToast(updated.enabled ? "Website widget enabled." : "Website widget disabled.", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to update widget status.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function copyEmbedCode() {
    if (!selected?.embedCode) return;
    try {
      await navigator.clipboard.writeText(selected.embedCode);
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
          <p>{unlimitedWidgets ? "Create separate website widgets for different sites, landing pages, offers, campaigns or departments." : "Add AI Caller’s primary web chat widget to your website. Unlimited unlocks additional website widgets."}</p>
        </div>
      </div>

      <div className="webchatWidgetManager">
        <div className="webchatWidgetManagerHeader">
          <div><strong>Website widgets</strong><small>{unlimitedWidgets ? "Unlimited widgets are active for this business." : "Core includes the primary website widget."}</small></div>
          {unlimitedWidgets && <button type="button" className="webchatAddWidgetButton" disabled={creating} onClick={() => void createWidget()}>{creating ? "Creating..." : "+ Add widget"}</button>}
        </div>
        <div className="webchatWidgetTabs">
          {widgets.map((widget) => {
            const available = widget.isPrimary || unlimitedWidgets;
            return (
              <button key={widget.id} type="button" className={selected?.id === widget.id ? "active" : ""} onClick={() => setSelectedId(widget.id)}>
                <span>{widget.name}</span>
                <small>{widget.isPrimary ? "Core primary" : available ? (widget.enabled ? "Active" : "Disabled") : "Unlimited required"}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="webchatWorkspace">
        <div className="webchatConfigColumn">
          <section className="webchatPanel appearancePanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon">💬</span>
              <div><h3>Widget settings</h3><p>Each widget keeps its own name, greeting and embed key.</p></div>
            </div>
            <label className="communicationField welcomeField">
              <span>Widget name</span>
              <input maxLength={80} value={widgetName} onChange={(event) => setWidgetName(event.target.value)} disabled={!selectedPlanAvailable} />
            </label>
            <label className="communicationField welcomeField">
              <span>Greeting</span>
              <textarea rows={3} maxLength={500} value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} disabled={!selectedPlanAvailable} />
              <small className="fieldCounter">{welcomeMessage.length}/500</small>
            </label>
            {!selectedPlanAvailable && selected && !selected.isPrimary && (
              <div className="editableNote communicationEditableNote">
                <span className="infoBubble"><InfoIcon size={18} /></span>
                <div><strong>Unlimited required</strong><p>This saved widget is retained, but it is not served publicly and cannot be edited until Unlimited is active again.</p></div>
              </div>
            )}
            <div className="webchatWidgetActions">
              <button type="button" className="webchatSaveButton" disabled={saving || loading || !selectedPlanAvailable} onClick={() => void saveWidget()}>{saving ? "Saving..." : "Save widget"}</button>
              {selected && <button type="button" className="outlineAction" disabled={saving || (!selectedPlanAvailable && !selected.enabled)} onClick={() => void toggleWidget()}>{selected.enabled ? "Disable widget" : "Enable widget"}</button>}
            </div>
          </section>

          <section className="webchatPanel embedPanel">
            <div className="webchatPanelHeading">
              <span className="webchatPanelIcon codeIcon">&lt;/&gt;</span>
              <div><h3>Embed on your website</h3><p>Add this code to your website&apos;s HTML just before the closing &lt;/body&gt; tag.</p></div>
            </div>
            <div className="embedCodeBox">
              <pre>{loading ? "Loading your widget code…" : selectedPlanAvailable ? selected?.embedCode ?? "Widget code is unavailable." : "Unlimited is required to use this additional widget."}</pre>
              <button type="button" disabled={!selected?.embedCode || !selectedPlanAvailable} onClick={copyEmbedCode}>▣ {copied ? "Copied" : "Copy code"}</button>
            </div>
          </section>
        </div>

        <section className="webchatPanel livePreviewPanel">
          <div className="livePreviewHeading"><h3>Live preview</h3><p>The greeting below uses the selected widget&apos;s content.</p></div>
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
