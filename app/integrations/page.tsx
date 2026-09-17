"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  CalendarIcon,
  DatabaseIcon,
  GearIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./integrations.css";

type Category = "all" | "communication" | "ai" | "scheduling";
type ProviderId = "plivo" | "telnyx" | "twilio" | "whatsapp" | "credits" | "openai" | "gemini" | "openrouter" | "google" | "outlook" | "calendly" | "calcom";

type Provider = {
  id: ProviderId;
  name: string;
  category: Exclude<Category, "all">;
  description: string;
  features: string[];
  brand: string;
  connected?: boolean;
};

const providers: Provider[] = [
  { id: "plivo", name: "Plivo", category: "communication", description: "Voice, SMS and WhatsApp messaging with your own Plivo account.", features: ["Voice calls", "SMS", "WhatsApp"], brand: "PL" },
  { id: "telnyx", name: "Telnyx", category: "communication", description: "Global communications for voice, messaging and WhatsApp.", features: ["Voice calls", "SMS", "WhatsApp"], brand: "TX" },
  { id: "twilio", name: "Twilio", category: "communication", description: "Reliable voice, SMS and WhatsApp messaging for your business.", features: ["Voice calls", "SMS", "WhatsApp"], brand: "TW", connected: true },
  { id: "whatsapp", name: "WhatsApp", category: "communication", description: "Connect the official WhatsApp Business Cloud API.", features: ["Messages", "Templates", "Webhooks"], brand: "WA" },
  { id: "credits", name: "Our Credits", category: "ai", description: "Use AI Caller credits without bringing your own AI provider.", features: ["Pay as you go", "Multiple models", "Usage tracking"], brand: "CR", connected: true },
  { id: "openai", name: "OpenAI", category: "ai", description: "Use your own OpenAI API key for AI conversations.", features: ["GPT models", "Structured output", "Tool calling"], brand: "OA" },
  { id: "gemini", name: "Gemini", category: "ai", description: "Use Google Gemini models with your own API key.", features: ["Gemini models", "Multimodal", "Tool calling"], brand: "GM" },
  { id: "openrouter", name: "OpenRouter", category: "ai", description: "Access multiple model providers through one API.", features: ["Many models", "Cost routing", "Unified API"], brand: "OR" },
  { id: "google", name: "Google Calendar", category: "scheduling", description: "Sync availability and appointments with Google Calendar.", features: ["Availability", "Create events", "Two-way sync"], brand: "GC", connected: true },
  { id: "outlook", name: "Outlook", category: "scheduling", description: "Sync your Microsoft Outlook calendar.", features: ["Availability", "Create events", "Two-way sync"], brand: "OL" },
  { id: "calendly", name: "Calendly", category: "scheduling", description: "Use your Calendly event types and availability.", features: ["Event types", "Availability", "Booking links"], brand: "CL" },
  { id: "calcom", name: "Cal.com", category: "scheduling", description: "Connect Cal.com scheduling and event types.", features: ["Event types", "Availability", "Two-way sync"], brand: "CA" },
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

export default function IntegrationsPage() {
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<ProviderId | null>("twilio");
  const [connected, setConnected] = useState<Record<ProviderId, boolean>>(() => Object.fromEntries(providers.map((p) => [p.id, Boolean(p.connected)])) as Record<ProviderId, boolean>);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((provider) => {
      const matchesCategory = category === "all" || provider.category === category;
      const matchesSearch = !q || [provider.name, provider.description, ...provider.features].some((value) => value.toLowerCase().includes(q));
      const isConnected = connected[provider.id];
      const matchesStatus = status === "all" || (status === "connected" ? isConnected : !isConnected);
      return matchesCategory && matchesSearch && matchesStatus;
    });
  }, [category, query, status, connected]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  const counts = {
    all: providers.length,
    communication: providers.filter((p) => p.category === "communication").length,
    ai: providers.filter((p) => p.category === "ai").length,
    scheduling: providers.filter((p) => p.category === "scheduling").length,
  };

  return (
    <main className="appShell integrationsShell">
      <aside className="appSidebar integrationsSidebar">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}>
              <span className="appNavIcon">{item.icon}</span><span>{item.label}</span>{item.badge && <b className="navBadge">{item.badge}</b>}
            </Link>
          ))}
        </nav>
        <a className="integrationsHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace integrationsWorkspace">
        <header className="integrationsTopbar">
          <label className="integrationsGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, integrations..." /><kbd>⌘ K</kbd></label>
          <div className="integrationsTopActions">
            <button className="integrationsAgentStatus" type="button"><i />AI Agent Online <ChevronDown /></button>
            <button className="integrationsCredit" type="button"><MessageIcon size={15} />2,480 credits</button>
            <button className="integrationsBell" type="button" aria-label="Notifications">♧<i /></button>
            <div className="profileBlock integrationsProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className={`integrationsBody ${selected ? "drawerOpen" : ""}`}>
          <div className="integrationsTitleRow">
            <div><h1>Integrations</h1><p>Connect the tools that power your AI agent.</p></div>
            <button className="docsButton" type="button">↗ View integration docs</button>
          </div>

          <div className="integrationTabs" role="tablist" aria-label="Integration categories">
            {tabs.map((tab) => <button key={tab.id} type="button" className={category === tab.id ? "active" : ""} onClick={() => setCategory(tab.id)}>{tab.label}<span>{counts[tab.id]}</span></button>)}
          </div>

          <div className="integrationFilters">
            <label><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search integrations..." /></label>
            <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Connection status"><option value="all">All statuses</option><option value="connected">Connected</option><option value="not-connected">Not connected</option></select>
          </div>

          {(["communication", "ai", "scheduling"] as const).map((section) => {
            const sectionProviders = visible.filter((provider) => provider.category === section);
            if (!sectionProviders.length) return null;
            return <section className="integrationSection" key={section}>
              <div className="integrationSectionHeading"><h2>{section === "communication" ? "Communication" : section === "ai" ? "AI" : "Scheduling"}</h2><p>{section === "communication" ? "Connect communication providers for calls and messaging." : section === "ai" ? "Choose how your agent processes conversations." : "Connect calendars and scheduling platforms."}</p></div>
              <div className="integrationGrid">
                {sectionProviders.map((provider) => <IntegrationCard key={provider.id} provider={provider} connected={connected[provider.id]} selected={selectedId === provider.id} onOpen={() => setSelectedId(provider.id)} />)}
              </div>
            </section>;
          })}

          {visible.length === 0 && <div className="emptyIntegrations">No integrations match your filters.</div>}
        </div>

        {selected && <IntegrationDrawer provider={selected} connected={connected[selected.id]} onClose={() => setSelectedId(null)} onConnectedChange={(value) => setConnected((current) => ({ ...current, [selected.id]: value }))} />}
      </section>
    </main>
  );
}

function IntegrationCard({ provider, connected, selected, onOpen }: { provider: Provider; connected: boolean; selected: boolean; onOpen: () => void }) {
  return <article className={`integrationCard ${selected ? "selected" : ""}`}>
    <div className="integrationCardTop"><span className={`providerMark ${provider.id}`}>{provider.brand}</span><div><strong>{provider.name}</strong><span className={`connectionBadge ${connected ? "connected" : ""}`}>{connected ? "● Connected" : "+ Not connected"}</span></div></div>
    <p>{provider.description}</p>
    <ul>{provider.features.map((feature) => <li key={feature}>✓ {feature}</li>)}</ul>
    <button type="button" className={connected ? "manageIntegration" : "connectIntegration"} onClick={onOpen}>{connected ? "Manage" : "Connect"}</button>
  </article>;
}

function IntegrationDrawer({ provider, connected, onClose, onConnectedChange }: { provider: Provider; connected: boolean; onClose: () => void; onConnectedChange: (value: boolean) => void }) {
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const update = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const save = () => { setSaved(true); onConnectedChange(true); window.setTimeout(() => setSaved(false), 1600); };

  return <aside className="integrationDrawer" aria-label={`${provider.name} integration settings`}>
    <button type="button" className="drawerClose" onClick={onClose} aria-label="Close integration panel">×</button>
    <div className="drawerProviderHeader"><span className={`providerMark large ${provider.id}`}>{provider.brand}</span><div><h2>{provider.name}</h2><span className={`connectionBadge ${connected ? "connected" : ""}`}>{connected ? "● Connected" : "Not connected"}</span><p>{provider.description}</p></div></div>

    {provider.id === "credits" ? <CreditsPanel /> : provider.category === "communication" ? <CommunicationPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} /> : provider.category === "ai" ? <AiPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} /> : <SchedulingPanel provider={provider.id} values={values} update={update} showSecret={showSecret} setShowSecret={setShowSecret} />}

    {provider.id !== "credits" && <div className="drawerActions"><button type="button" className="primaryDrawerAction" onClick={save}>{saved ? "Saved" : connected ? "Save changes" : "Connect account"}</button><button type="button" className="secondaryDrawerAction">Test connection</button>{connected && <button type="button" className="dangerDrawerAction" onClick={() => onConnectedChange(false)}>Disconnect</button>}</div>}
  </aside>;
}

function CommunicationPanel({ provider, values, update, showSecret, setShowSecret }: PanelProps) {
  if (provider === "plivo") return <CredentialForm title="Plivo credentials" note="Enter the credentials from your Plivo console."><Field label="Auth ID" value={values.authId || ""} onChange={(v) => update("authId", v)} placeholder="MA..." /><SecretField label="Auth Token" value={values.authToken || ""} onChange={(v) => update("authToken", v)} show={showSecret} setShow={setShowSecret} /><Field label="Phone number" value={values.phone || ""} onChange={(v) => update("phone", v)} placeholder="+1 234 567 8900" /></CredentialForm>;
  if (provider === "telnyx") return <CredentialForm title="Telnyx credentials" note="Use your Telnyx API key and connection details."><SecretField label="API Key" value={values.apiKey || ""} onChange={(v) => update("apiKey", v)} show={showSecret} setShow={setShowSecret} /><Field label="Connection ID" value={values.connectionId || ""} onChange={(v) => update("connectionId", v)} placeholder="123456789" /><Field label="Phone number" value={values.phone || ""} onChange={(v) => update("phone", v)} placeholder="+1 234 567 8900" /></CredentialForm>;
  if (provider === "whatsapp") return <CredentialForm title="WhatsApp Cloud API" note="Enter credentials from Meta Business Manager."><SecretField label="Permanent access token" value={values.token || ""} onChange={(v) => update("token", v)} show={showSecret} setShow={setShowSecret} /><Field label="Phone Number ID" value={values.phoneNumberId || ""} onChange={(v) => update("phoneNumberId", v)} placeholder="123456789012345" /><Field label="WhatsApp Business Account ID" value={values.businessId || ""} onChange={(v) => update("businessId", v)} placeholder="123456789012345" /><SecretField label="Webhook verify token" value={values.verifyToken || ""} onChange={(v) => update("verifyToken", v)} show={showSecret} setShow={setShowSecret} /></CredentialForm>;
  return <CredentialForm title="Twilio credentials" note="Enter the credentials from your Twilio console."><Field label="Account SID" value={values.sid || ""} onChange={(v) => update("sid", v)} placeholder="ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" /><SecretField label="Auth Token" value={values.authToken || ""} onChange={(v) => update("authToken", v)} show={showSecret} setShow={setShowSecret} /><Field label="Phone number" value={values.phone || ""} onChange={(v) => update("phone", v)} placeholder="+1 234 567 8900" /><Field label="WhatsApp number" value={values.whatsapp || ""} onChange={(v) => update("whatsapp", v)} placeholder="+1 234 567 8900" /><SelectField label="Region" value={values.region || "US1 (Virginia)"} onChange={(v) => update("region", v)} options={["US1 (Virginia)", "AU1 (Australia)", "IE1 (Ireland)"]} /></CredentialForm>;
}

function AiPanel({ provider, values, update, showSecret, setShowSecret }: PanelProps) {
  const config = provider === "openai" ? { title: "OpenAI API", placeholder: "sk-...", models: ["gpt-5.6", "gpt-5.6-mini", "gpt-4.1-mini"] } : provider === "gemini" ? { title: "Gemini API", placeholder: "AIza...", models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"] } : { title: "OpenRouter API", placeholder: "sk-or-...", models: ["openai/gpt-5.6", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4"] };
  return <CredentialForm title={config.title} note="Your key is stored securely and used only for your account."><SecretField label="API Key" value={values.apiKey || ""} onChange={(v) => update("apiKey", v)} show={showSecret} setShow={setShowSecret} placeholder={config.placeholder} /><SelectField label="Default model" value={values.model || config.models[0]} onChange={(v) => update("model", v)} options={config.models} />{provider === "openrouter" && <Field label="Site URL (optional)" value={values.siteUrl || ""} onChange={(v) => update("siteUrl", v)} placeholder="https://yourdomain.com" />}<div className="inlineSetting"><div><strong>Use provider for new conversations</strong><small>Existing conversations keep their current provider.</small></div><Toggle checked /></div></CredentialForm>;
}

function SchedulingPanel({ provider, values, update, showSecret, setShowSecret }: PanelProps) {
  if (provider === "google") return <CredentialForm title="Google Calendar" note="Google Calendar uses OAuth rather than an API key for normal user accounts."><button className="oauthButton" type="button">G&nbsp;&nbsp; Connect Google account</button><SelectField label="Calendar" value={values.calendar || "Primary calendar"} onChange={(v) => update("calendar", v)} options={["Primary calendar", "Sales calendar", "Appointments"]} /><ToggleRow title="Two-way sync" subtitle="Keep AI Caller and Google Calendar in sync." /></CredentialForm>;
  if (provider === "outlook") return <CredentialForm title="Microsoft Outlook" note="Connect your Microsoft account securely with OAuth."><button className="oauthButton microsoft" type="button">M&nbsp;&nbsp; Connect Microsoft account</button><SelectField label="Calendar" value={values.calendar || "Calendar"} onChange={(v) => update("calendar", v)} options={["Calendar", "Bookings", "Team calendar"]} /><ToggleRow title="Two-way sync" subtitle="Keep AI Caller and Outlook in sync." /></CredentialForm>;
  if (provider === "calendly") return <CredentialForm title="Calendly credentials" note="Use a Calendly personal access token for this MVP connection."><SecretField label="Personal Access Token" value={values.token || ""} onChange={(v) => update("token", v)} show={showSecret} setShow={setShowSecret} placeholder="eyJ..." /><Field label="Organization URI (optional)" value={values.org || ""} onChange={(v) => update("org", v)} placeholder="https://api.calendly.com/organizations/..." /><ToggleRow title="Sync event types" subtitle="Import active Calendly event types." /></CredentialForm>;
  return <CredentialForm title="Cal.com credentials" note="Enter your Cal.com API key."><SecretField label="API Key" value={values.apiKey || ""} onChange={(v) => update("apiKey", v)} show={showSecret} setShow={setShowSecret} placeholder="cal_live_..." /><Field label="Username / team slug" value={values.slug || ""} onChange={(v) => update("slug", v)} placeholder="your-team" /><ToggleRow title="Sync event types" subtitle="Import Cal.com event types and availability." /></CredentialForm>;
}

function CreditsPanel() {
  return <div className="credentialsCard"><div className="creditsHero"><span>2,480</span><small>credits available</small></div><div className="creditUsage"><div><strong>520</strong><small>Used this cycle</small></div><div><strong>3,000</strong><small>Cycle allowance</small></div></div><button type="button" className="primaryDrawerAction">Top up credits</button><button type="button" className="secondaryDrawerAction">View usage</button></div>;
}

type PanelProps = { provider: ProviderId; values: Record<string, string>; update: (key: string, value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void };

function CredentialForm({ title, note, children }: { title: string; note: string; children: React.ReactNode }) { return <div className="credentialsCard"><div className="credentialIntro"><strong>{title}</strong><p>{note}</p></div><div className="credentialFields">{children}</div></div>; }
function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) { return <label className="integrationField"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function SecretField({ label, value, onChange, show, setShow, placeholder = "••••••••••••••••" }: { label: string; value: string; onChange: (value: string) => void; show: boolean; setShow: (value: boolean) => void; placeholder?: string }) { return <label className="integrationField"><span>{label}</span><div className="secretInput"><input type={show ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><button type="button" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button></div></label>; }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label className="integrationField"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }
function ToggleRow({ title, subtitle }: { title: string; subtitle: string }) { return <div className="inlineSetting"><div><strong>{title}</strong><small>{subtitle}</small></div><Toggle checked /></div>; }
function Toggle({ checked }: { checked: boolean }) { return <span className={`miniToggle ${checked ? "on" : ""}`}><i /></span>; }
function SearchIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function ChevronDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>; }
