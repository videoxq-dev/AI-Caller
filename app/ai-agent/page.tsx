"use client";

import Link from "next/link";
import { AppNav } from "@/components/core-domain/app-nav";
import { useEffect, useState } from "react";
import {
  CalendarIcon,
  GearIcon,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./ai-agent.css";

type AgentTab = "overview" | "knowledge" | "behavior" | "capabilities" | "test";
type AgentStatus = "DRAFT" | "ACTIVE" | "PAUSED";
type Capability = { key: string; label: string; description: string };
type DashboardData = { metrics: Record<"inquiries" | "aiConversations" | "qualifiedLeads" | "appointments", { value: number }>; credit: { balance: number }; activity: Array<{ id: string; label: string; detail: string; occurredAt: string; href: string }> };
type Channel = "WhatsApp" | "Phone" | "SMS" | "Web Chat";
type QualificationCriterion = { id: string; label: string; question: string; required: boolean };
type AgentApiRecord = {
  id: string;
  status: AgentStatus;
  name: string;
  tone: string;
  primaryGoal: string;
  whenUnsure: string;
  advancedInstructions: string | null;
  openingMessage: string | null;
  escalationMessage: string | null;
  behaviorSettings: Record<string, unknown>;
};

type TestMessage = {
  id: number;
  role: "customer" | "agent";
  text: string;
};

type TestResult = {
  action: string;
  toolResult: { kind: string; data: Record<string, unknown> };
  simulated: boolean;
};

export default function AIAgentPage() {
  const [tab, setTab] = useState<AgentTab>("overview");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("DRAFT");
  const [hasAgent, setHasAgent] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [capabilityCatalog, setCapabilityCatalog] = useState<Capability[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [capabilitiesSaved, setCapabilitiesSaved] = useState(false);
  const [knowledgeCounts, setKnowledgeCounts] = useState({ services: 0, faqs: 0, policies: 0 });
  const [saved, setSaved] = useState(false);
  const [tone, setTone] = useState("Friendly & professional");
  const [goal, setGoal] = useState("Book appointments");
  const [whenUnsure, setWhenUnsure] = useState("Escalate to a human");
  const [verbosity, setVerbosity] = useState("Concise");
  const [guardrails, setGuardrails] = useState({ pricing: true, availability: true, approvedInfo: true, collectContact: true });
  const [assistantName, setAssistantName] = useState("AI Assistant");
  const [openingMessage, setOpeningMessage] = useState("");
  const [escalationMessage, setEscalationMessage] = useState("");
  const [advancedInstructions, setAdvancedInstructions] = useState<string | null>(null);
  const [voiceProfile, setVoiceProfile] = useState("ava-us-1");
  const [voiceLanguage, setVoiceLanguage] = useState("en-US");
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [recordingPolicy, setRecordingPolicy] = useState<"ANNOUNCE" | "EXPLICIT_CONSENT">("ANNOUNCE");
  const [afterHoursEnabled, setAfterHoursEnabled] = useState(true);
  const [qualificationEnabled, setQualificationEnabled] = useState(false);
  const [qualificationCriteria, setQualificationCriteria] = useState<QualificationCriterion[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load AI agent settings.");
        return response.json() as Promise<{ agent: AgentApiRecord | null; capabilities: Record<string, boolean> | null; capabilityCatalog: Capability[]; canManage: boolean; services: unknown[]; faqs: unknown[]; policies: unknown[] }>;
      })
      .then(({ agent, capabilities: stored, capabilityCatalog: catalog, canManage: manage, services, faqs, policies }) => {
        if (cancelled) return;
        setCapabilityCatalog(catalog);
        setCanManage(manage);
        setKnowledgeCounts({ services: services.length, faqs: faqs.length, policies: policies.length });
        setCapabilities(stored ?? {});
        if (!agent) return;
        setAgentStatus(agent.status);
        setHasAgent(true);
        setAssistantName(agent.name);
        setTone(agent.tone);
        setGoal(agent.primaryGoal);
        setWhenUnsure(agent.whenUnsure);
        setOpeningMessage(agent.openingMessage ?? "");
        setEscalationMessage(agent.escalationMessage ?? "");
        setAdvancedInstructions(agent.advancedInstructions);
        const behavior = agent.behaviorSettings ?? {};
        const rules = Array.isArray(behavior.guardrails) ? behavior.guardrails.filter((item): item is string => typeof item === "string") : [];
        setGuardrails({
          pricing: rules.includes("Never invent pricing"),
          availability: rules.includes("Never confirm unavailable appointments"),
          approvedInfo: rules.includes("Only answer based on approved business information") || rules.includes("Only answer from approved business information"),
          collectContact: rules.includes("Collect customer name and phone number before handing off") || rules.includes("Collect customer name and contact before handoff"),
        });
        const voice = behavior.voice && typeof behavior.voice === "object" ? behavior.voice as Record<string, unknown> : {};
        if (typeof voice.profileKey === "string") setVoiceProfile(voice.profileKey);
        if (typeof voice.language === "string") setVoiceLanguage(voice.language);
        if (typeof voice.speakingRate === "number") setVoiceSpeed(voice.speakingRate);
        if (voice.recordingPolicy === "ANNOUNCE" || voice.recordingPolicy === "EXPLICIT_CONSENT") setRecordingPolicy(voice.recordingPolicy);
        if (typeof voice.afterHoursEnabled === "boolean") setAfterHoursEnabled(voice.afterHoursEnabled);
        const qualification = behavior.qualification && typeof behavior.qualification === "object" ? behavior.qualification as Record<string, unknown> : {};
        if (typeof qualification.enabled === "boolean") setQualificationEnabled(qualification.enabled);
        if (Array.isArray(qualification.criteria)) {
          const parsed = qualification.criteria.filter((item): item is QualificationCriterion => {
            if (!item || typeof item !== "object") return false;
            const value = item as Record<string, unknown>;
            return typeof value.id === "string" && typeof value.label === "string" && typeof value.question === "string" && typeof value.required === "boolean";
          });
          if (parsed.length) setQualificationCriteria(parsed);
        }
      })
      .catch((err) => { if (!cancelled) setSettingsError(err instanceof Error ? err.message : "Unable to load AI agent settings."); })
      .finally(() => { if (!cancelled) setLoadingSettings(false); });
    return () => { cancelled = true; };
  }, [setGoal, setTone, setWhenUnsure]);

  const updateStatus = async (selected?: AgentStatus) => {
    const next: AgentStatus = selected ?? (agentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE");
    setSavingSettings(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/agent/status", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const payload = await response.json() as { agent?: AgentApiRecord; error?: { message?: string } };
      if (!response.ok || !payload.agent) throw new Error(payload.error?.message ?? "Unable to change agent status.");
      setAgentStatus(payload.agent.status);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to change agent status.");
    } finally {
      setSavingSettings(false);
    }
  };

  const saveCapabilities = async () => {
    setSavingSettings(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/agent/capabilities", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify(capabilities),
      });
      const payload = await response.json() as { agent?: AgentApiRecord; error?: { message?: string } };
      if (!response.ok || !payload.agent) throw new Error(payload.error?.message ?? "Unable to save capabilities.");
      setCapabilities(payload.agent.behaviorSettings.capabilities as Record<string, boolean>);
      setCapabilitiesSaved(true);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to save capabilities.");
    } finally {
      setSavingSettings(false);
    }
  };

  const saveChanges = async () => {
    setSavingSettings(true);
    setSettingsError(null);
    const rules = [
      guardrails.pricing ? "Never invent pricing" : null,
      guardrails.availability ? "Never confirm unavailable appointments" : null,
      guardrails.approvedInfo ? "Only answer based on approved business information" : null,
      guardrails.collectContact ? "Collect customer name and phone number before handing off" : null,
    ].filter((value): value is string => Boolean(value));
    try {
      const response = await fetch("/api/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: assistantName,
          tone,
          primaryGoal: goal,
          whenUnsure,
          advancedInstructions,
          openingMessage: openingMessage || null,
          escalationMessage: escalationMessage || null,
          guardrails: rules,
          voice: {
            profileKey: voiceProfile,
            language: voiceLanguage,
            speakingRate: voiceSpeed,
            recordingPolicy,
            afterHoursEnabled,
          },
          qualification: {
            enabled: qualificationEnabled,
            criteria: qualificationCriteria,
          },
          completeStep: false,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { agent?: AgentApiRecord; error?: { message?: string } };
      if (!response.ok || !payload.agent) throw new Error(payload.error?.message ?? "Unable to save AI agent settings.");
      // A newly created agent did not exist on the first GET, so the
      // capabilities editor must load its persisted legacy-default policy now.
      const refreshed = await fetch("/api/agent", { cache: "no-store" });
      const current = await refreshed.json() as {
        capabilities?: Record<string, boolean>; error?: { message?: string };
      };
      if (!refreshed.ok || !current.capabilities) {
        throw new Error(current.error?.message ?? "Agent saved, but the capability policy could not be loaded.");
      }
      setCapabilities(current.capabilities);
      setHasAgent(true);
      setAgentStatus(payload.agent.status);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Unable to save AI agent settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <main className="appShell agentShell">
      <AppNav active="AI Agent" className="appSidebar agentSidebar" />

      <section className="appWorkspace agentWorkspace">
        <header className="agentTopbar">
          <Link className="agentGlobalSearch" href="/inbox">Open Inbox</Link>
          <div className="agentTopActions">
            <Link className="agentOnlinePill" href="/settings">Phone &amp; Messaging settings</Link>
          </div>
        </header>

        <div className="agentBody">
          <div className="agentTitleRow">
            <div><h1>AI Agent</h1><p>Configure, train and test your AI agent.</p></div>
            <div className="agentTitleActions"><span className={`agentState ${agentStatus === "ACTIVE" ? "online" : "paused"}`}><i />{loadingSettings ? "Loading status…" : `Agent ${agentStatus.toLowerCase()}`}</span>{tab === "behavior" && <button type="button" disabled={savingSettings || loadingSettings || !canManage} onClick={() => void saveChanges()}>{savingSettings ? "Saving…" : saved ? "Saved" : "Save changes"}</button>}</div>
          </div>

          {settingsError && <div className="agentSettingsError">{settingsError}</div>}
          <div className="agentTabs" role="tablist" aria-label="AI Agent sections">
            {(["overview", "knowledge", "behavior", "capabilities", "test"] as AgentTab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
          </div>

          {tab === "overview" && <OverviewTab agentName={assistantName} status={agentStatus} configured={hasAgent} onStatusChange={updateStatus} canManage={canManage} loading={loadingSettings || savingSettings} setTab={setTab} />}
          {tab === "knowledge" && <KnowledgeTab counts={knowledgeCounts} />}
          {tab === "behavior" && <BehaviorTab tone={tone} setTone={setTone} goal={goal} setGoal={setGoal} whenUnsure={whenUnsure} setWhenUnsure={setWhenUnsure} verbosity={verbosity} setVerbosity={setVerbosity} guardrails={guardrails} setGuardrails={setGuardrails} assistantName={assistantName} setAssistantName={setAssistantName} openingMessage={openingMessage} setOpeningMessage={setOpeningMessage} escalationMessage={escalationMessage} setEscalationMessage={setEscalationMessage} voiceProfile={voiceProfile} setVoiceProfile={setVoiceProfile} voiceLanguage={voiceLanguage} setVoiceLanguage={setVoiceLanguage} voiceSpeed={voiceSpeed} setVoiceSpeed={setVoiceSpeed} recordingPolicy={recordingPolicy} setRecordingPolicy={setRecordingPolicy} afterHoursEnabled={afterHoursEnabled} setAfterHoursEnabled={setAfterHoursEnabled} qualificationEnabled={qualificationEnabled} setQualificationEnabled={setQualificationEnabled} qualificationCriteria={qualificationCriteria} setQualificationCriteria={setQualificationCriteria} />}
          {tab === "capabilities" && <CapabilitiesTab catalog={capabilityCatalog} capabilities={capabilities} setCapabilities={(value) => { setCapabilitiesSaved(false); setCapabilities(value); }} saved={capabilitiesSaved} onSave={saveCapabilities} loading={loadingSettings || savingSettings} canManage={canManage} />}
          {tab === "test" && <TestTab />}
        </div>
      </section>
    </main>
  );
}

function OverviewTab({ agentName, status, configured, onStatusChange, canManage, loading, setTab }: {
  agentName: string; status: AgentStatus; configured: boolean; onStatusChange: (next?: AgentStatus) => void;
  canManage: boolean; loading: boolean; setTab: (tab: AgentTab) => void;
}) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [managedNumber, setManagedNumber] = useState<{ status: string; messagingReadiness: string } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/phone-numbers", { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("Phone status unavailable."); return response.json(); })
      .then((data: { number: { status: string; messagingReadiness: string } | null }) => { if (!cancelled) setManagedNumber(data.number); })
      .catch(() => { if (!cancelled) setPhoneError("Phone status unavailable."); });
    fetch("/api/dashboard?days=7", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load operational metrics.");
        return response.json() as Promise<DashboardData>;
      })
      .then((value) => { if (!cancelled) setDashboard(value); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Metrics unavailable."); });
    return () => { cancelled = true; };
  }, []);

  return <div className="agentTabContent">
    <section className="overviewTopGrid">
      <article className="agentHeroCard">
        <div className="agentBotAvatar"><BotFaceIcon /></div>
        <div className="agentHeroCopy">
          <div className="agentHeroName"><h2>{agentName}</h2><span>{status}</span></div>
          <p>{!configured ? "Configure your AI Agent from Behavior before activating it." :
            status === "ACTIVE" ? "Your configured agent is active for eligible inbound conversations." :
            status === "PAUSED" ? "New AI replies are paused. Incoming messages remain in your Inbox." :
            "Activate your agent after checking its knowledge, capabilities and communication setup."}</p>
          <div className="agentHeroButtons">
            <button type="button" disabled={loading || !canManage || !configured} onClick={() => onStatusChange()}>
              {status === "ACTIVE" ? <PauseIcon /> : <PlayIcon />}{status === "ACTIVE" ? "Pause agent" : "Activate agent"}
            </button>
            {configured && status !== "DRAFT" && <button type="button" disabled={loading || !canManage}
              onClick={() => onStatusChange("DRAFT")}>Return to draft</button>}
            <button type="button" onClick={() => setTab("behavior")}><GearIcon size={16} />Edit settings</button>
          </div>
        </div>
      </article>
      <article className="agentCard quickActionsCard">
        <h3>Manage your AI</h3>
        <button type="button" onClick={() => setTab("knowledge")}><span><DocumentIcon /></span><strong>Update business knowledge</strong></button>
        <button type="button" onClick={() => setTab("capabilities")}><span><GearIcon /></span><strong>Manage capabilities</strong></button>
        <button type="button" onClick={() => setTab("test")}><span><MessageIcon /></span><strong>Test your agent</strong></button>
        <Link href="/settings"><strong>Phone &amp; Messaging status</strong></Link>
      </article>
    </section>
    <section className="agentCard">
      <div className="agentCardHeader"><h3>Managed phone and messaging</h3><Link href="/settings">Configure</Link></div>
      <p>{phoneError ?? (managedNumber
        ? `Phone: ${managedNumber.status} · Outbound SMS: ${managedNumber.messagingReadiness}`
        : "No managed phone number connected.")}</p>
      <p>Phone activation and outbound SMS approval are separate. One managed number per workspace.</p>
    </section>
    <section className="agentMetricGrid">
      <Metric icon={<MessageIcon size={20} />} label="Inbound inquiries · 7 days" value={dashboard?.metrics.inquiries.value} />
      <Metric icon={<MessageIcon size={20} />} label="AI conversations · 7 days" value={dashboard?.metrics.aiConversations.value} />
      <Metric icon={<UsersIcon size={20} />} label="Qualified leads · 7 days" value={dashboard?.metrics.qualifiedLeads.value} />
      <Metric icon={<CalendarIcon size={20} />} label="Appointments booked · 7 days" value={dashboard?.metrics.appointments.value} />
    </section>
    {error && <div className="agentSettingsError">{error}</div>}
    <section className="agentBottomGrid">
      <article className="agentCard recentConversationsCard">
        <div className="agentCardHeader"><h3>Recent activity</h3><Link href="/inbox">Open Inbox</Link></div>
        {dashboard ? dashboard.activity.length
          ? dashboard.activity.map((item) => <div className="agentActivityRow" key={item.id}>
              <Link href={item.href}><strong>{item.label}</strong></Link><span>{item.detail}</span>
              <time>{new Date(item.occurredAt).toLocaleString()}</time>
            </div>)
          : <p>No activity recorded in the last 7 days.</p>
          : <p>{error ? "Activity is unavailable." : "Loading actual activity…"}</p>}
      </article>
      <article className="agentCard quickActionsCard"><h3>Hosted credits</h3>
        <p>{dashboard ? dashboard.credit.balance.toLocaleString() : error ? "Unavailable" : "Loading…"}</p>
        <Link href="/settings">Manage credits and billing</Link>
      </article>
    </section>
  </div>;
}

function KnowledgeTab({ counts }: { counts: { services: number; faqs: number; policies: number } }) {
  return <div className="agentTabContent">
    <section className="agentCard knowledgeMainCard">
      <div className="sectionTitle"><div><h2>Business knowledge</h2><p>The AI uses your saved business profile, services, FAQs, policies and imported knowledge.</p></div>
        <Link href="/setup/ai">Manage knowledge</Link>
      </div>
      <div className="knowledgeList">
        <p>Saved services: {counts.services}</p>
        <p>Saved FAQs: {counts.faqs}</p>
        <p>Saved policies: {counts.policies}</p>
        <p>Manage imported documents and website information from your existing AI setup.</p>
      </div>
    </section>
  </div>;
}

function CapabilitiesTab({ catalog, capabilities, setCapabilities, saved, onSave, loading, canManage }: {
  catalog: Capability[]; capabilities: Record<string, boolean>;
  setCapabilities: (value: Record<string, boolean>) => void; saved: boolean; onSave: () => void;
  loading: boolean; canManage: boolean;
}) {
  return <div className="agentTabContent"><section className="agentCard behaviorCard">
    <div className="sectionTitle"><div><h2>Agent capabilities</h2>
      <p>These permissions control actual backend tools. Existing SMS consent, carrier and workspace protections always apply.</p>
    </div></div>
    {catalog.map((item) => <div className="behaviorToggleRow" key={item.key}>
      <div><strong>{item.label}</strong><small>{item.description}</small></div>
      <button type="button" aria-label={item.label} aria-pressed={capabilities[item.key] === true}
        disabled={loading || !canManage} className={`switch ${capabilities[item.key] ? "on" : ""}`}
        onClick={() => setCapabilities({ ...capabilities, [item.key]: !capabilities[item.key] })}><i /></button>
    </div>)}
    {!catalog.length && <p>{loading ? "Loading capabilities…" : "No capabilities available."}</p>}
    <button type="button" disabled={loading || !canManage || !catalog.length} onClick={onSave}>{loading ? "Saving…" : saved ? "Capabilities saved" : "Save capabilities"}</button>
  </section></div>;
}

function BehaviorTab({
  tone, setTone, goal, setGoal, whenUnsure, setWhenUnsure, verbosity, setVerbosity,
  guardrails, setGuardrails, assistantName, setAssistantName, openingMessage, setOpeningMessage,
  escalationMessage, setEscalationMessage, voiceProfile, setVoiceProfile, voiceLanguage,
  setVoiceLanguage, voiceSpeed, setVoiceSpeed, recordingPolicy, setRecordingPolicy,
  afterHoursEnabled, setAfterHoursEnabled, qualificationEnabled, setQualificationEnabled,
  qualificationCriteria, setQualificationCriteria,
}: {
  tone: string; setTone: (value: string) => void;
  goal: string; setGoal: (value: string) => void;
  whenUnsure: string; setWhenUnsure: (value: string) => void;
  verbosity: string; setVerbosity: (value: string) => void;
  guardrails: { pricing: boolean; availability: boolean; approvedInfo: boolean; collectContact: boolean };
  setGuardrails: (value: { pricing: boolean; availability: boolean; approvedInfo: boolean; collectContact: boolean }) => void;
  assistantName: string; setAssistantName: (value: string) => void;
  openingMessage: string; setOpeningMessage: (value: string) => void;
  escalationMessage: string; setEscalationMessage: (value: string) => void;
  voiceProfile: string; setVoiceProfile: (value: string) => void;
  voiceLanguage: string; setVoiceLanguage: (value: string) => void;
  voiceSpeed: number; setVoiceSpeed: (value: number) => void;
  recordingPolicy: "ANNOUNCE" | "EXPLICIT_CONSENT";
  setRecordingPolicy: (value: "ANNOUNCE" | "EXPLICIT_CONSENT") => void;
  afterHoursEnabled: boolean; setAfterHoursEnabled: (value: boolean) => void;
  qualificationEnabled: boolean; setQualificationEnabled: (value: boolean) => void;
  qualificationCriteria: QualificationCriterion[];
  setQualificationCriteria: (value: QualificationCriterion[]) => void;
}) {
  const updateCriterion = (index: number, patch: Partial<QualificationCriterion>) => {
    setQualificationCriteria(qualificationCriteria.map((criterion, position) =>
      position === index ? { ...criterion, ...patch } : criterion,
    ));
  };

  const addCriterion = () => {
    if (qualificationCriteria.length >= 10) return;
    const id = `question_${Date.now().toString(36)}`;
    setQualificationCriteria([
      ...qualificationCriteria,
      { id, label: "New field", question: "What would you like to ask?", required: false },
    ]);
  };

  return (
    <div className="agentTabContent behaviorLayout">
      <section className="behaviorMain">
        <article className="agentCard behaviorCard">
          <div className="sectionTitle compact"><div><h2>Identity &amp; voice</h2><p>Configure the assistant identity and inbound-call voice.</p></div></div>
          <div className="behaviorFields two">
            <label>Assistant name<input value={assistantName} onChange={(event) => setAssistantName(event.target.value)} /></label>
            <label>Tone<select value={tone} onChange={(event) => setTone(event.target.value)}><option>Friendly & professional</option><option>Warm & casual</option><option>Direct & concise</option><option>Formal</option></select></label>
            <label>Primary goal<select value={goal} onChange={(event) => setGoal(event.target.value)}><option>Book appointments</option><option>Qualify leads</option><option>Answer questions</option><option>Capture contact details</option></select></label>
            <label>Response length<select value={verbosity} onChange={(event) => setVerbosity(event.target.value)}><option>Concise</option><option>Balanced</option><option>Detailed</option></select></label>
            <label>Phone voice<select value={voiceProfile} onChange={(event) => setVoiceProfile(event.target.value)}><option value="ava-us-1">Ava — warm &amp; professional</option><option value="marcus-us-1">Marcus — calm &amp; confident</option><option value="sofia-us-1">Sofia — friendly &amp; upbeat</option><option value="james-us-1">James — clear &amp; direct</option></select></label>
            <label>Voice language<select value={voiceLanguage} onChange={(event) => setVoiceLanguage(event.target.value)}><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="es-US">Spanish (US)</option></select></label>
            <label>Speaking speed<select value={String(voiceSpeed)} onChange={(event) => setVoiceSpeed(Number(event.target.value))}><option value="0.85">Relaxed</option><option value="1">Natural</option><option value="1.15">Brisk</option></select></label>
            <label>Recording consent<select value={recordingPolicy} onChange={(event) => setRecordingPolicy(event.target.value as "ANNOUNCE" | "EXPLICIT_CONSENT")}><option value="ANNOUNCE">Announce before recording</option><option value="EXPLICIT_CONSENT">Require explicit consent</option></select></label>
          </div>
          <div className="behaviorToggleRow"><div><strong>After-hours AI</strong><small>Use after-hours context when the business is closed.</small></div><button type="button" className={`switch ${afterHoursEnabled ? "on" : ""}`} onClick={() => setAfterHoursEnabled(!afterHoursEnabled)} aria-pressed={afterHoursEnabled}><i /></button></div>
        </article>

        <article className="agentCard behaviorCard">
          <div className="sectionTitle compact"><div><h2>Lead qualification</h2><p>These criteria are shared by web chat, SMS, WhatsApp and phone calls.</p></div></div>
          <div className="behaviorToggleRow"><div><strong>Qualify incoming leads</strong><small>The AI collects explicit answers naturally; the server decides when required fields are complete.</small></div><button type="button" className={`switch ${qualificationEnabled ? "on" : ""}`} onClick={() => setQualificationEnabled(!qualificationEnabled)} aria-pressed={qualificationEnabled}><i /></button></div>
          {qualificationEnabled && <div className="agentQualificationList">
            {qualificationCriteria.map((criterion, index) => <div className="agentQualificationRow" key={criterion.id}>
              <label><span>Field</span><input value={criterion.label} maxLength={120} onChange={(event) => updateCriterion(index, { label: event.target.value })} /></label>
              <label className="question"><span>Question</span><input value={criterion.question} maxLength={300} onChange={(event) => updateCriterion(index, { question: event.target.value })} /></label>
              <label className="required"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />Required</label>
              <button type="button" className="removeQualification" disabled={qualificationCriteria.length <= 1} onClick={() => setQualificationCriteria(qualificationCriteria.filter((_, position) => position !== index))}>×</button>
            </div>)}
            <button type="button" className="addQualification" disabled={qualificationCriteria.length >= 10} onClick={addCriterion}>＋ Add qualification question</button>
          </div>}
        </article>

        <article className="agentCard behaviorCard"><div className="sectionTitle compact"><div><h2>Conversation behavior</h2><p>What the AI should do in common situations.</p></div></div><div className="behaviorFields"><label>When unsure<select value={whenUnsure} onChange={(event) => setWhenUnsure(event.target.value)}><option>Escalate to a human</option><option>Ask a clarifying question</option><option>Collect details for follow-up</option></select></label><label>Opening message<textarea value={openingMessage} onChange={(event) => setOpeningMessage(event.target.value)} /></label><label>Escalation message<textarea value={escalationMessage} onChange={(event) => setEscalationMessage(event.target.value)} /></label></div></article>

        <article className="agentCard behaviorCard"><div className="sectionTitle compact"><div><h2>Guardrails</h2><p>Rules the AI must always follow.</p></div></div><div className="guardrailRows"><GuardrailRow label="Never invent pricing" checked={guardrails.pricing} onChange={(value) => setGuardrails({ ...guardrails, pricing: value })} /><GuardrailRow label="Never confirm unavailable appointments" checked={guardrails.availability} onChange={(value) => setGuardrails({ ...guardrails, availability: value })} /><GuardrailRow label="Only answer from approved business information" checked={guardrails.approvedInfo} onChange={(value) => setGuardrails({ ...guardrails, approvedInfo: value })} /><GuardrailRow label="Collect customer name and contact before handoff" checked={guardrails.collectContact} onChange={(value) => setGuardrails({ ...guardrails, collectContact: value })} /></div></article>
      </section>

      <aside className="behaviorSide">
        <article className="agentCard behaviorSummary"><h3>Current behavior</h3><span><small>Tone</small><strong>{tone}</strong></span><span><small>Goal</small><strong>{goal}</strong></span><span><small>Phone voice</small><strong>{voiceProfile.split("-")[0]}</strong></span><span><small>Lead qualification</small><strong>{qualificationEnabled ? `${qualificationCriteria.filter((item) => item.required).length} required fields` : "Off"}</strong></span><span><small>When unsure</small><strong>{whenUnsure}</strong></span></article>
      </aside>
    </div>
  );
}

function TestTab() {
  const [channel, setChannel] = useState<Channel>("Web Chat");
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [resetNext, setResetNext] = useState(false);
  const [lastResult, setLastResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [embedCode, setEmbedCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/widget/config")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load embed code.");
        return response.json() as Promise<{ embedCode: string }>;
      })
      .then((data) => { if (!cancelled) setEmbedCode(data.embedCode); })
      .catch(() => { if (!cancelled) setEmbedCode(""); });
    return () => { cancelled = true; };
  }, []);

  const resetTest = () => {
    setMessages([]);
    setLastResult(null);
    setError(null);
    setResetNext(true);
  };

  const send = async () => {
    const value = input.trim();
    if (!value || sending || channel !== "Web Chat") return;
    const customerMessage: TestMessage = { id: Date.now(), role: "customer", text: value };
    setMessages((current) => [...current, customerMessage]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const response = await fetch("/api/agent/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: value, history: messages.map((message) => ({
          role: message.role === "customer" ? "user" : "assistant", content: message.text,
        })), reset: resetNext, clientMessageId: crypto.randomUUID() }),
      });
      const payload = await response.json() as {
        reply?: string | null;
        action?: string;
        toolResult?: { kind: string; data: Record<string, unknown> };
        simulated?: boolean;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? "The test request failed.");
      setResetNext(false);
      setLastResult({
        action: payload.action ?? "NONE",
        toolResult: payload.toolResult ?? { kind: "none", data: {} },
        simulated: payload.simulated === true,
      });
      setMessages((current) => [...current, {
        id: Date.now() + 1,
        role: "agent",
        text: payload.reply ?? "No AI reply was generated because this conversation is in human-handling mode.",
      }]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The test request failed.");
    } finally {
      setSending(false);
    }
  };

  const copyEmbed = async () => {
    if (!embedCode) return;
    await navigator.clipboard.writeText(embedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const actionLabel = lastResult?.action === "NONE" ? "Answered directly" : lastResult?.action?.replaceAll("_", " ") ?? "No test yet";
  const toolLabel = lastResult ? `${lastResult.toolResult.kind}${lastResult.simulated ? " (simulated)" : ""}` : "No tool call yet";

  return (
    <div className="agentTabContent testLayout">
      <section className="agentCard testPanel">
        <div className="testHeader"><div><h2>Test your AI</h2><p>Run a real AI conversation using your saved business knowledge. Booking and escalation side effects are simulated here.</p></div><button type="button" onClick={resetTest}>Reset test</button></div>
        <div className="testChannelTabs">{(["Web Chat", "WhatsApp", "SMS", "Phone"] as Channel[]).map((item) => <button key={item} type="button" className={channel === item ? "active" : ""} onClick={() => setChannel(item)}>{channelIcon(item)}{item}</button>)}</div>
        <div className="testConversation"><div className="testConversationTop"><span className={`testChannelIcon ${channelClass(channel)}`}>{channelIcon(channel)}</span><div><strong>Test conversation</strong><small>{channel === "Web Chat" ? "Live orchestrator" : "Available in a later channel milestone"}</small></div><em><i />{channel === "Web Chat" ? (sending ? "AI thinking" : "AI ready") : "Not wired yet"}</em></div><div className="testMessages">{messages.length === 0 && <div className="testMessage agent"><span>Ask a business question, test lead qualification, or ask to book an appointment.</span><small>AI Caller test mode</small></div>}{messages.map((message) => <div key={message.id} className={`testMessage ${message.role}`}><span>{message.text}</span><small>{message.role === "agent" ? "AI agent" : "Test customer"}</small></div>)}{error && <div className="testMessage agent"><span>{error}</span><small>Test error</small></div>}</div><div className="testComposer"><input disabled={channel !== "Web Chat" || sending} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void send(); }} placeholder={channel === "Web Chat" ? "Type a test message..." : `${channel} testing comes in a later milestone`} /><button disabled={channel !== "Web Chat" || sending || !input.trim()} type="button" onClick={() => void send()}><SendIcon /></button></div></div>
      </section>

      <aside className="testSideColumn">
        <article className="agentCard testChecklist"><h3>Test checklist</h3><ChecklistItem label="Business questions" status={messages.length > 1 ? "Tested" : "Not tested"} /><ChecklistItem label="Lead qualification" status={lastResult?.toolResult.kind === "qualification" ? "Observed" : "Not tested"} /><ChecklistItem label="Calendar availability" status={lastResult?.toolResult.kind === "availability" ? "Tested" : "Not tested"} /><ChecklistItem label="Appointment booking" status={lastResult?.toolResult.kind === "booking" ? "Simulated" : "Not tested"} /><ChecklistItem label="Human escalation" status={lastResult?.toolResult.kind === "escalation" ? "Simulated" : "Not tested"} /></article>
        <article className="agentCard testInsight"><h3>AI response details</h3><span><small>Channel</small><strong>{channel}</strong></span><span><small>Action</small><strong>{actionLabel}</strong></span><span><small>Server tool</small><strong>{toolLabel}</strong></span><span><small>Side effects</small><strong>{lastResult?.simulated ? "Simulated in Test" : "Normal test behavior"}</strong></span></article>
        <article className="agentCard readinessCard" style={{ display: "block" }}><div style={{ width: "100%" }}><strong>Web Chat embed code</strong><p>Paste this script before the closing &lt;/body&gt; tag on your website.</p><code style={{ display: "block", marginTop: 10, padding: 10, borderRadius: 8, background: "#f5f7fb", color: "#26344d", fontSize: 11, lineHeight: 1.45, overflowWrap: "anywhere" }}>{embedCode || "Loading embed code…"}</code><button type="button" onClick={() => void copyEmbed()} disabled={!embedCode} style={{ marginTop: 10 }}>{copied ? "Copied" : "Copy embed code"}</button></div></article>
      </aside>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value?: number }) { return <article className="agentCard agentMetric"><span className="metricArt blue">{icon}</span><div><small>{label}</small><strong>{value === undefined ? "—" : value.toLocaleString()}</strong><p>{value === undefined ? "Loading actual data…" : "Recorded activity"}</p></div></article>; }
function GuardrailRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="guardrailRow"><span>{label}</span><button type="button" className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><i /></button></div>; }
function ChecklistItem({ label, status }: { label: string; status: string }) { return <div className="checklistItem"><span>✓</span><strong>{label}</strong><em>{status}</em></div>; }
function channelClass(channel: Channel) { return channel.toLowerCase().replace(/\s+/g, "-"); }
function channelIcon(channel: Channel) { if (channel === "Phone") return <PhoneIcon size={15} />; if (channel === "WhatsApp") return <WhatsAppIcon />; return <MessageIcon size={15} />; }

function WhatsAppIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4.1A8 8 0 1 1 20 11.5Z"/><path d="M8.5 8.5c.8 2.4 2.4 4 4.8 4.8"/></svg>; }
function DocumentIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></svg>; }
function PauseIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>; }
function PlayIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7Z"/></svg>; }
function BotFaceIcon() { return <svg width="52" height="52" viewBox="0 0 64 64" fill="none"><rect x="10" y="18" width="44" height="34" rx="12" fill="#173c86"/><rect x="16" y="24" width="32" height="22" rx="8" fill="#f4f8ff"/><circle cx="26" cy="34" r="3" fill="#173c86"/><circle cx="38" cy="34" r="3" fill="#173c86"/><path d="M25 41h14" stroke="#173c86" strokeWidth="3" strokeLinecap="round"/><path d="M32 18v-7" stroke="#173c86" strokeWidth="4" strokeLinecap="round"/><circle cx="32" cy="8" r="4" fill="#173c86"/></svg>; }
function SendIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>; }
