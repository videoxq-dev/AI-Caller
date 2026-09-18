"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarIcon,
  DatabaseIcon,
  GearIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./integrations.css";
import "./provider-connect.css";

type Category = "all" | "communication" | "ai" | "scheduling";
type ProviderId = "plivo" | "telnyx" | "twilio" | "whatsapp" | "credits" | "openai" | "gemini" | "openrouter" | "google" | "outlook" | "calendly" | "calcom";
type IntegrationRecord = {
  provider: ProviderId;
  status: "CONNECTED" | "ERROR" | "DISCONNECTED";
  settings?: Record<string, unknown>;
  maskedCredentials?: Record<string, string>;
  lastTestedAt?: string | null;
  lastError?: string | null;
};

type Provider = {
  id: ProviderId;
  name: string;
  category: Exclude<Category, "all">;
  description: string;
  features: string[];
  brand: string;
};

type MetaConfig = { enabled: boolean; appId: string | null; configId: string | null; graphApiVersion: string };
type MetaSession = { wabaId: string; phoneNumberId: string; businessId?: string | null };

declare global {
  interface Window {
    FB?: {
      init(config: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
      login(callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>): void;
    };
  }
}

const providers: Provider[] = [
  { id: "plivo", name: "Plivo", category: "communication", description: "SMS with your own Plivo account. Voice support is planned after the Telnyx inbound milestone.", features: ["SMS", "Inbound SMS webhooks", "BYOP credentials"], brand: "PL" },
  { id: "telnyx", name: "Telnyx", category: "communication", description: "Global communications for voice and messaging.", features: ["Voice calls", "SMS", "Inbound webhooks"], brand: "TX" },
  { id: "twilio", name: "Twilio", category: "communication", description: "SMS with your own Twilio account. Voice support is planned after the Telnyx inbound milestone.", features: ["SMS", "Inbound SMS webhooks", "BYOP credentials"], brand: "TW" },
  { id: "whatsapp", name: "WhatsApp", category: "communication", description: "Connect WhatsApp directly through AI Caller's approved Meta Tech Provider app.", features: ["Embedded Signup", "Cloud API", "Webhooks"], brand: "WA" },
  { id: "credits", name: "Our Credits", category: "ai", description: "Use AI Caller credits without bringing your own AI provider.", features: ["Hosted AI", "Usage tracking", "No API key"], brand: "CR" },
  { id: "openai", name: "OpenAI", category: "ai", description: "Use your own OpenAI API key for AI conversations.", features: ["GPT models", "Structured output", "Tool calling"], brand: "OA" },
  { id: "gemini", name: "Gemini", category: "ai", description: "Use Google Gemini models with your own API key.", features: ["Gemini models", "Multimodal", "Tool calling"], brand: "GM" },
  { id: "openrouter", name: "OpenRouter", category: "ai", description: "Access multiple model providers through one API.", features: ["Many models", "Cost routing", "Unified API"], brand: "OR" },
  { id: "google", name: "Google Calendar", category: "scheduling", description: "Connect with Google OAuth for availability and appointments.", features: ["OAuth", "Availability", "Create events"], brand: "GC" },
  { id: "outlook", name: "Outlook", category: "scheduling", description: "Connect Microsoft Outlook Calendar with OAuth.", features: ["OAuth", "Availability", "Create events"], brand: "OL" },
  { id: "calendly", name: "Calendly", category: "scheduling", description: "Use your Calendly event types and availability.", features: ["Event types", "Availability", "Booking links"], brand: "CL" },
  { id: "calcom", name: "Cal.com", category: "scheduling", description: "Connect Cal.com API v2 scheduling and event types.", features: ["API v2", "Availability", "Bookings"], brand: "CA" },
];

const tabs: Array<{ id: Category; label: string }> = [
  { id: "all", label: "All" },
  { id: "communication", label: "Communication" },
  { id: "ai", label: "AI" },
  { id: "scheduling", label: "Scheduling" },
];

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} />, active: true },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

const emptyConnected = () => Object.fromEntries(providers.map((provider) => [provider.id, provider.id === "credits"])) as Record<ProviderId, boolean>;

export default function IntegrationsPage() {
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);
  const [connected, setConnected] = useState<Record<ProviderId, boolean>>(emptyConnected);
  const [records, setRecords] = useState<Partial<Record<ProviderId, IntegrationRecord>>>({});
  const [pageNotice, setPageNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("provider") as ProviderId | null;
    setSelectedId(requested && providers.some((provider) => provider.id === requested) ? requested : "twilio");
    const connection = params.get("connection");
    if (connection === "connected") setPageNotice({ tone: "success", text: "Provider connected successfully." });
    if (connection === "error") setPageNotice({ tone: "error", text: params.get("message") || "Provider connection failed." });

    fetch("/api/integrations", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load integrations")))
      .then((payload) => {
        const rows = Array.isArray(payload?.integrations) ? payload.integrations as IntegrationRecord[] : [];
        const nextConnected = emptyConnected();
        const nextRecords: Partial<Record<ProviderId, IntegrationRecord>> = {};
        for (const row of rows) {
          if (!providers.some((provider) => provider.id === row.provider)) continue;
          nextConnected[row.provider] = row.status === "CONNECTED";
          nextRecords[row.provider] = row;
        }
        setConnected(nextConnected);
        setRecords(nextRecords);
      })
      .catch(() => setPageNotice({ tone: "error", text: "Unable to load saved integrations." }));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((provider) => {
      const matchesCategory = category === "all" || provider.category === category;
      const matchesSearch = !q || [provider.name, provider.description, ...provider.features].some((value) => value.toLowerCase().includes(q));
      const matchesStatus = status === "all" || (status === "connected" ? connected[provider.id] : !connected[provider.id]);
      return matchesCategory && matchesSearch && matchesStatus;
    });
  }, [category, query, status, connected]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  const counts = {
    all: providers.length,
    communication: providers.filter((provider) => provider.category === "communication").length,
    ai: providers.filter((provider) => provider.category === "ai").length,
    scheduling: providers.filter((provider) => provider.category === "scheduling").length,
  };

  function updateRecord(record: IntegrationRecord | null, providerId: ProviderId) {
    setConnected((current) => ({ ...current, [providerId]: record?.status === "CONNECTED" || providerId === "credits" }));
    setRecords((current) => ({ ...current, [providerId]: record ?? undefined }));
  }

  return (
    <main className="appShell integrationsShell">
      <aside className="appSidebar integrationsSidebar">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">{navItems.map((item) => <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}><span className="appNavIcon">{item.icon}</span><span>{item.label}</span>{item.badge && <b className="navBadge">{item.badge}</b>}</Link>)}</nav>
        <a className="integrationsHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace integrationsWorkspace">
        <header className="integrationsTopbar">
          <label className="integrationsGlobalSearch"><SearchIcon /><input name="global-integrations-search" autoComplete="off" data-lpignore="true" data-1p-ignore="true" placeholder="Search contacts, appointments, integrations..." /><kbd>⌘ K</kbd></label>
          <div className="integrationsTopActions"><button className="integrationsAgentStatus" type="button"><i />AI Agent Online <ChevronDown /></button><button className="integrationsCredit" type="button"><MessageIcon size={15} />2,480 credits</button><button className="integrationsBell" type="button" aria-label="Notifications">♧<i /></button><div className="profileBlock integrationsProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div></div>
        </header>

        <div className={`integrationsBody ${selected ? "drawerOpen" : ""}`}>
          <div className="integrationsTitleRow"><div><h1>Integrations</h1><p>Connect the tools that power your AI agent.</p></div><button className="docsButton" type="button">↗ View integration docs</button></div>
          {pageNotice && <div className={`integrationPageNotice ${pageNotice.tone === "error" ? "error" : ""}`}>{pageNotice.text}</div>}
          <div className="integrationTabs" role="tablist" aria-label="Integration categories">{tabs.map((tab) => <button key={tab.id} type="button" className={category === tab.id ? "active" : ""} onClick={() => setCategory(tab.id)}>{tab.label}<span>{counts[tab.id]}</span></button>)}</div>
          <div className="integrationFilters"><label><SearchIcon /><input name="integration-catalog-search" autoComplete="off" data-lpignore="true" data-1p-ignore="true" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search integrations..." /></label><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Connection status"><option value="all">All statuses</option><option value="connected">Connected</option><option value="not-connected">Not connected</option></select></div>
          {(["communication", "ai", "scheduling"] as const).map((section) => {
            const sectionProviders = visible.filter((provider) => provider.category === section);
            if (!sectionProviders.length) return null;
            return <section className="integrationSection" key={section}><div className="integrationSectionHeading"><h2>{section === "communication" ? "Communication" : section === "ai" ? "AI" : "Scheduling"}</h2><p>{section === "communication" ? "Connect communication providers for calls and messaging." : section === "ai" ? "Choose how your agent processes conversations." : "Connect calendars and scheduling platforms."}</p></div><div className="integrationGrid">{sectionProviders.map((provider) => <IntegrationCard key={provider.id} provider={provider} connected={connected[provider.id]} selected={selectedId === provider.id} onOpen={() => setSelectedId(provider.id)} />)}</div></section>;
          })}
          {visible.length === 0 && <div className="emptyIntegrations">No integrations match your filters.</div>}
        </div>
        {selected && <IntegrationDrawer key={selected.id} provider={selected} connected={connected[selected.id]} record={records[selected.id]} onClose={() => setSelectedId(null)} onRecordChange={(record) => updateRecord(record, selected.id)} />}
      </section>
    </main>
  );
}

function IntegrationCard({ provider, connected, selected, onOpen }: { provider: Provider; connected: boolean; selected: boolean; onOpen: () => void }) {
  return <article className={`integrationCard ${selected ? "selected" : ""}`}><div className="integrationCardTop"><span className={`providerMark ${provider.id}`}>{provider.brand}</span><div><strong>{provider.name}</strong><span className={`connectionBadge ${connected ? "connected" : ""}`}>{connected ? "● Connected" : "+ Not connected"}</span></div></div><p>{provider.description}</p><ul>{provider.features.map((feature) => <li key={feature}>✓ {feature}</li>)}</ul><button type="button" className={connected ? "manageIntegration" : "connectIntegration"} onClick={onOpen}>{connected ? "Manage" : "Connect"}</button></article>;
}

function categoryFor(provider: Provider): "AI" | "COMMUNICATION" | "WHATSAPP" | "CALENDAR" {
  if (provider.id === "whatsapp") return "WHATSAPP";
  if (provider.category === "communication") return "COMMUNICATION";
  if (provider.category === "ai") return "AI";
  return "CALENDAR";
}

const credentialKeys: Partial<Record<ProviderId, string[]>> = {
  plivo: ["authId", "authToken", "phone"],
  telnyx: ["apiKey", "connectionId", "phone"],
  twilio: ["sid", "authToken", "phone"],
  openai: ["apiKey"], gemini: ["apiKey"], openrouter: ["apiKey"], calendly: ["token"], calcom: ["apiKey"],
};

function IntegrationDrawer({ provider, connected, record, onClose, onRecordChange }: { provider: Provider; connected: boolean; record?: IntegrationRecord; onClose: () => void; onRecordChange: (record: IntegrationRecord | null) => void }) {
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(record?.settings ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>);
  const update = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const hasSavedSecret = Boolean(record?.maskedCredentials && Object.keys(record.maskedCredentials).length);
  const oauthCalendar = provider.id === "google" || provider.id === "outlook";

  async function bindAI(mode: "HOSTED" | "BYOP", providerId?: ProviderId) {
    const response = await fetch("/api/integrations/capabilities", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: "AI_TEXT", mode, provider: providerId ?? null }) });
    if (!response.ok) throw new Error("Connection was saved, but AI routing could not be updated.");
  }

  async function save() {
    setSaving(true); setNotice(null);
    try {
      const secretKeys = new Set(credentialKeys[provider.id] ?? []);
      const credentials = Object.fromEntries(Object.entries(values).filter(([key, value]) => secretKeys.has(key) && value.trim()));
      const settings = Object.fromEntries(Object.entries(values).filter(([key]) => !secretKeys.has(key)));
      if (!hasSavedSecret && (credentialKeys[provider.id]?.length ?? 0) > 0 && Object.keys(credentials).length === 0) throw new Error("Enter the required connection credentials before saving.");
      const response = await fetch("/api/integrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.id, category: categoryFor(provider), mode: "BYOP", credentials, settings }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save integration.");
      onRecordChange(payload.integration as IntegrationRecord);
      setValues((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !secretKeys.has(key))));
      if (payload?.test?.ok) {
        if (provider.category === "ai") await bindAI("BYOP", provider.id);
        setNotice({ tone: "success", text: "Connection verified and saved securely." });
      } else {
        setNotice({ tone: "error", text: payload?.test?.error ?? "Credentials were saved, but the provider connection test failed." });
      }
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to save integration." }); }
    finally { setSaving(false); }
  }

  async function testConnection() {
    setSaving(true); setNotice(null);
    try {
      const response = await fetch(`/api/integrations/${provider.id}/test`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to test provider connection.");
      onRecordChange(payload.integration as IntegrationRecord);
      setNotice(payload.ok ? { tone: "success", text: "Connection test passed." } : { tone: "error", text: payload.error ?? "Connection test failed." });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Connection test failed." }); }
    finally { setSaving(false); }
  }

  async function disconnect() {
    setSaving(true); setNotice(null);
    try {
      const response = await fetch("/api/integrations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.id, status: "DISCONNECTED" }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to disconnect integration.");
      onRecordChange(payload.integration as IntegrationRecord);
      setNotice({ tone: "success", text: "Integration disconnected." });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to disconnect integration." }); }
    finally { setSaving(false); }
  }

  async function useHostedAI() {
    setSaving(true); setNotice(null);
    try { await bindAI("HOSTED"); setNotice({ tone: "success", text: "Hosted AI is now the active AI capability." }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to update AI routing." }); }
    finally { setSaving(false); }
  }

  return (
    <aside className="integrationDrawer" aria-label={`${provider.name} integration settings`}>
      <button type="button" className="drawerClose" onClick={onClose} aria-label="Close integration panel">×</button>
      <div className="drawerProviderHeader"><span className={`providerMark large ${provider.id}`}>{provider.brand}</span><div><h2>{provider.name}</h2><span className={`connectionBadge ${connected ? "connected" : ""}`}>{connected ? "● Connected" : record?.status === "ERROR" ? "Connection error" : "Not connected"}</span><p>{provider.description}</p></div></div>
      {provider.id === "credits" ? <CreditsPanel onUseHosted={useHostedAI} busy={saving} /> : provider.id === "whatsapp" ? <MetaEmbeddedSignupPanel record={record} onRecordChange={onRecordChange} setNotice={setNotice} /> : oauthCalendar ? <OAuthCalendarPanel provider={provider.id as "google" | "outlook"} record={record} /> : provider.category === "communication" ? <CommunicationPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} hasSavedSecret={hasSavedSecret} /> : provider.category === "ai" ? <AiPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} hasSavedSecret={hasSavedSecret} /> : <SchedulingPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} hasSavedSecret={hasSavedSecret} />}
      {record?.lastTestedAt && <div className="providerLastTest">Last tested {new Date(record.lastTestedAt).toLocaleString()}</div>}
      {record?.lastError && <div className="providerErrorText">{record.lastError}</div>}
      {notice && <div className={`integrationNotice ${notice.tone}`}>{notice.text}</div>}
      {provider.id !== "credits" && <div className="providerActionRow">
        {!oauthCalendar && provider.id !== "whatsapp" && <button type="button" className="primaryDrawerAction" disabled={saving} onClick={save}>{saving ? "Checking..." : connected ? "Save & verify changes" : "Connect & verify"}</button>}
        {record && <button type="button" className="secondaryDrawerAction" disabled={saving} onClick={testConnection}>Test connection</button>}
        {connected && <button type="button" className="dangerDrawerAction" disabled={saving} onClick={disconnect}>Disconnect</button>}
      </div>}
    </aside>
  );
}

type NoticeSetter = (notice: { tone: "success" | "error"; text: string } | null) => void;

function MetaEmbeddedSignupPanel({ record, onRecordChange, setNotice }: { record?: IntegrationRecord; onRecordChange: (record: IntegrationRecord) => void; setNotice: NoticeSetter }) {
  const [config, setConfig] = useState<MetaConfig | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [authCode, setAuthCode] = useState<string | null>(null);
  const [session, setSession] = useState<MetaSession | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    fetch("/api/integrations/meta/config", { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load Meta configuration."))).then((payload: MetaConfig) => setConfig(payload)).catch((error) => setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to load Meta configuration." }));
  }, [setNotice]);

  useEffect(() => {
    if (!config?.enabled || !config.appId) return;
    const initialize = () => {
      window.FB?.init({ appId: config.appId!, autoLogAppEvents: true, xfbml: true, version: config.graphApiVersion });
      setSdkReady(Boolean(window.FB));
    };
    if (window.FB) { initialize(); return; }
    const existing = document.getElementById("facebook-jssdk") as HTMLScriptElement | null;
    if (existing) { existing.addEventListener("load", initialize, { once: true }); return () => existing.removeEventListener("load", initialize); }
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.addEventListener("load", initialize, { once: true });
    document.body.appendChild(script);
    return () => script.removeEventListener("load", initialize);
  }, [config]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const origin = new URL(event.origin);
        if (origin.protocol !== "https:" || (origin.hostname !== "facebook.com" && !origin.hostname.endsWith(".facebook.com"))) return;
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;
        if (payload.event === "FINISH") {
          const data = payload.data ?? {};
          if (data.waba_id && data.phone_number_id) setSession({ wabaId: String(data.waba_id), phoneNumberId: String(data.phone_number_id), businessId: data.business_id ? String(data.business_id) : null });
        }
        if (payload.event === "CANCEL") setNotice({ tone: "error", text: "Meta Embedded Signup was cancelled before completion." });
        if (payload.event === "ERROR") setNotice({ tone: "error", text: "Meta reported an error during Embedded Signup." });
      } catch { return; }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [setNotice]);

  useEffect(() => {
    if (!authCode || !session || connecting) return;
    setConnecting(true);
    fetch("/api/integrations/meta/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: authCode, wabaId: session.wabaId, phoneNumberId: session.phoneNumberId, businessId: session.businessId ?? null }) })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to finish WhatsApp connection."); return payload; })
      .then((payload) => { onRecordChange(payload.integration as IntegrationRecord); setNotice({ tone: "success", text: "WhatsApp connected through Meta Embedded Signup." }); setAuthCode(null); setSession(null); })
      .catch((error) => setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to finish WhatsApp connection." }))
      .finally(() => setConnecting(false));
  }, [authCode, session, connecting, onRecordChange, setNotice]);

  function startSignup() {
    if (!config?.enabled || !config.configId || !window.FB) { setNotice({ tone: "error", text: "Meta Embedded Signup is not configured or ready." }); return; }
    setNotice(null); setAuthCode(null); setSession(null);
    window.FB.login((response) => {
      const code = response.authResponse?.code;
      if (code) setAuthCode(code);
      else setNotice({ tone: "error", text: "Meta authorization was not completed." });
    }, { config_id: config.configId, response_type: "code", override_default_response_type: true, extras: { sessionInfoVersion: "3" } });
  }

  const settings = record?.settings ?? {};
  return <section className="providerConnectCard"><span className="metaProviderBadge">Meta Tech Provider connection</span><h3>{record?.status === "CONNECTED" ? "WhatsApp Business connected" : "Connect with Meta"}</h3><p>Customers authorize AI Caller through Meta's Embedded Signup. They never copy API tokens or webhook secrets into AI Caller.</p><ul className="providerConnectBenefits"><li>Official Meta Cloud API connection</li><li>WABA and phone-number discovery</li><li>Automatic webhook subscription</li><li>Access token stays encrypted server-side</li></ul>{record?.status === "CONNECTED" && <div className="connectedMetadata"><div><span>Business</span><strong>{String(settings.verifiedName ?? settings.wabaName ?? "Connected business")}</strong></div><div><span>WhatsApp number</span><strong>{String(settings.displayPhoneNumber ?? "Connected")}</strong></div><div><span>WABA ID</span><strong>{String(settings.wabaId ?? "—")}</strong></div></div>}<button className="metaConnectButton" type="button" disabled={!config?.enabled || !sdkReady || connecting} onClick={startSignup}>{connecting ? "Finishing connection..." : record?.status === "CONNECTED" ? "Reconnect with Meta" : "Connect with Meta"}</button>{config && !config.enabled && <p className="providerErrorText">Set the Meta Tech Provider environment variables before connecting customer accounts.</p>}</section>;
}

function OAuthCalendarPanel({ provider, record }: { provider: "google" | "outlook"; record?: IntegrationRecord }) {
  const settings = record?.settings ?? {};
  const label = provider === "google" ? "Google Calendar" : "Microsoft Outlook";
  const href = `/api/integrations/oauth/${provider}/start?return=${encodeURIComponent(`/integrations?provider=${provider}`)}`;
  return <section className="providerConnectCard"><h3>{record?.status === "CONNECTED" ? `${label} connected` : `Connect ${label}`}</h3><p>Authorization happens directly with {provider === "google" ? "Google" : "Microsoft"}. AI Caller stores the refresh token encrypted and never returns it to the browser.</p>{record?.status === "CONNECTED" && <div className="connectedMetadata"><div><span>Calendar</span><strong>{String((settings.connectionMetadata as Record<string, unknown> | undefined)?.calendarName ?? settings.calendar ?? "Connected")}</strong></div><div><span>Auth method</span><strong>OAuth 2.0</strong></div></div>}<a className={`oauthConnectLink ${provider === "outlook" ? "microsoft" : ""}`} href={href}>{record?.status === "CONNECTED" ? `Reconnect ${label}` : `Connect ${label}`}</a></section>;
}

type PanelProps = { provider: ProviderId; values: Record<string, string>; update: (key: string, value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void; hasSavedSecret: boolean };
function SavedSecretNote({ saved }: { saved: boolean }) { return saved ? <div className="credentialSavedNote">Credentials are already saved. Leave secret fields blank to keep the existing values.</div> : null; }

function CommunicationPanel({ provider, values, update, showSecret, setShowSecret, hasSavedSecret }: PanelProps) {
  if (provider === "plivo") return <CredentialForm title="Plivo credentials" note="Enter the credentials from your Plivo console."><SavedSecretNote saved={hasSavedSecret} /><Field id="plivo-auth-id" label="Auth ID" value={values.authId || ""} onChange={(value) => update("authId", value)} placeholder="MA..." /><SecretField id="plivo-auth-token" label="Auth Token" value={values.authToken || ""} onChange={(value) => update("authToken", value)} show={showSecret} setShow={setShowSecret} /><Field id="plivo-phone" label="Phone number" value={values.phone || ""} onChange={(value) => update("phone", value)} placeholder="+1 234 567 8900" /></CredentialForm>;
  if (provider === "telnyx") return <CredentialForm title="Telnyx credentials" note="Use your Telnyx API key, Call Control connection and webhook signing public key."><SavedSecretNote saved={hasSavedSecret} /><SecretField id="telnyx-api-key" label="API Key" value={values.apiKey || ""} onChange={(value) => update("apiKey", value)} show={showSecret} setShow={setShowSecret} /><Field id="telnyx-connection-id" label="Connection ID" value={values.connectionId || ""} onChange={(value) => update("connectionId", value)} placeholder="123456789" /><Field id="telnyx-phone" label="Phone number" value={values.phone || ""} onChange={(value) => update("phone", value)} placeholder="+1 234 567 8900" /><Field id="telnyx-webhook-public-key" label="Webhook public key" value={values.webhookPublicKey || ""} onChange={(value) => update("webhookPublicKey", value)} placeholder="Base64 Ed25519 public key" /></CredentialForm>;
  return <CredentialForm title="Twilio credentials" note="Enter the credentials from your Twilio console."><SavedSecretNote saved={hasSavedSecret} /><Field id="twilio-account-sid" label="Account SID" value={values.sid || ""} onChange={(value) => update("sid", value)} placeholder="ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" /><SecretField id="twilio-auth-token" label="Auth Token" value={values.authToken || ""} onChange={(value) => update("authToken", value)} show={showSecret} setShow={setShowSecret} /><Field id="twilio-phone" label="Phone number" value={values.phone || ""} onChange={(value) => update("phone", value)} placeholder="+1 234 567 8900" /></CredentialForm>;
}

function AiPanel({ provider, values, update, showSecret, setShowSecret, hasSavedSecret }: PanelProps) {
  const config = provider === "openai" ? { title: "OpenAI API", key: "openai", placeholder: "sk-...", models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"] } : provider === "gemini" ? { title: "Gemini API", key: "gemini", placeholder: "AIza...", models: ["gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.5-flash"] } : { title: "OpenRouter API", key: "openrouter", placeholder: "sk-or-...", models: ["openai/gpt-5.6-sol", "google/gemini-3.8-flash", "anthropic/claude-sonnet-4"] };
  return <CredentialForm title={config.title} note="Your key is encrypted, verified with the provider, and never returned after save."><SavedSecretNote saved={hasSavedSecret} /><SecretField id={`${config.key}-api-key`} label="API Key" value={values.apiKey || ""} onChange={(value) => update("apiKey", value)} show={showSecret} setShow={setShowSecret} placeholder={config.placeholder} /><SelectField label="Default model" value={values.model || config.models[0]} onChange={(value) => update("model", value)} options={config.models} />{provider === "openrouter" && <Field id="openrouter-site-url" label="Site URL (optional)" value={values.siteUrl || ""} onChange={(value) => update("siteUrl", value)} placeholder="https://yourdomain.com" />}<ToggleRow title="Use provider for new conversations" subtitle="A successful connection makes this the active AI capability." /></CredentialForm>;
}

function SchedulingPanel({ provider, values, update, showSecret, setShowSecret, hasSavedSecret }: PanelProps) {
  if (provider === "calendly") return <CredentialForm title="Calendly credentials" note="Use a Calendly personal access token. AI Caller validates it against your Calendly profile."><SavedSecretNote saved={hasSavedSecret} /><SecretField id="calendly-access-token" label="Personal Access Token" value={values.token || ""} onChange={(value) => update("token", value)} show={showSecret} setShow={setShowSecret} placeholder="eyJ..." /><Field id="calendly-org-uri" label="Organization URI (optional)" value={values.org || ""} onChange={(value) => update("org", value)} placeholder="https://api.calendly.com/organizations/..." /><ToggleRow title="Sync event types" subtitle="Import active Calendly event types." /></CredentialForm>;
  return <CredentialForm title="Cal.com API v2" note="Enter your Cal.com API key. AI Caller validates it with the v2 /me endpoint."><SavedSecretNote saved={hasSavedSecret} /><SecretField id="calcom-api-key" label="API Key" value={values.apiKey || ""} onChange={(value) => update("apiKey", value)} show={showSecret} setShow={setShowSecret} placeholder="cal_live_..." /><Field id="calcom-slug" label="Username / team slug" value={values.slug || ""} onChange={(value) => update("slug", value)} placeholder="your-team" /><ToggleRow title="Sync event types" subtitle="Import Cal.com event types and availability." /></CredentialForm>;
}

function CreditsPanel({ onUseHosted, busy }: { onUseHosted: () => void; busy: boolean }) { return <div className="credentialsCard"><div className="creditsHero"><span>Hosted AI</span><small>Uses your AI Caller credit wallet</small></div><div className="creditUsage"><div><strong>Available</strong><small>No provider key required</small></div></div><button type="button" className="primaryDrawerAction" disabled={busy} onClick={onUseHosted}>Use hosted AI</button><Link href="/settings" className="secondaryDrawerAction">View usage &amp; credits</Link></div>; }
function CredentialForm({ title, note, children }: { title: string; note: string; children: ReactNode }) { return <div className="credentialsCard"><div className="credentialIntro"><strong>{title}</strong><p>{note}</p></div><div className="credentialFields">{children}</div></div>; }
function Field({ id, label, value, onChange, placeholder }: { id: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string }) { return <label className="integrationField" htmlFor={id}><span>{label}</span><input id={id} name={`integration-${id}`} autoComplete="off" data-lpignore="true" data-1p-ignore="true" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function SecretField({ id, label, value, onChange, show, setShow, placeholder = "••••••••••••••••" }: { id: string; label: string; value: string; onChange: (value: string) => void; show: boolean; setShow: (value: boolean) => void; placeholder?: string }) { return <label className="integrationField" htmlFor={id}><span>{label}</span><div className="secretInput"><input id={id} name={`integration-secret-${id}`} type={show ? "text" : "password"} autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><button type="button" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button></div></label>; }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label className="integrationField"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }
function ToggleRow({ title, subtitle }: { title: string; subtitle: string }) { return <div className="inlineSetting"><div><strong>{title}</strong><small>{subtitle}</small></div><Toggle checked /></div>; }
function Toggle({ checked }: { checked: boolean }) { return <span className={`miniToggle ${checked ? "on" : ""}`}><i /></span>; }
function SearchIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function ChevronDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>; }
function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M9 13h.01M15 13h.01M8 17h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m13 2-8 12h6l-1 8 9-13h-6V2Z"/></svg>; }
