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

const recentConversations = [
  { name: "Chioma Okafor", initials: "CO", channel: "WhatsApp" as Channel, message: "Hi, do you have ginger shots in stock?", outcome: "Appointment booked", time: "10 min ago" },
  { name: "Tunde Adebayo", initials: "TA", channel: "Phone" as Channel, message: "I'd like to know your pricing", outcome: "Information provided", time: "32 min ago" },
  { name: "Sarah Johnson", initials: "SJ", channel: "Web Chat" as Channel, message: "Can I book a consultation?", outcome: "Appointment booked", time: "1 hour ago" },
  { name: "Emeka Onuoha", initials: "EO", channel: "SMS" as Channel, message: "What are the ingredients?", outcome: "Information provided", time: "2 hours ago" },
];

const knowledgeItems = [
  { title: "Business profile", subtitle: "Business details, hours and service area", state: "Connected", icon: <BuildingIcon /> },
  { title: "Website", subtitle: "www.brightsideautospa.com", state: "Imported", icon: <LinkIcon /> },
  { title: "Services", subtitle: "3 services available to the AI", state: "3 items", icon: <ListIcon /> },
  { title: "FAQs", subtitle: "Common questions and approved answers", state: "12 items", icon: <QuestionIcon /> },
  { title: "Documents", subtitle: "PDF, DOCX and TXT reference files", state: "4 files", icon: <DocumentIcon /> },
];

export default function AIAgentPage() {
  const [tab, setTab] = useState<AgentTab>("overview");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("DRAFT");
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [capabilityCatalog, setCapabilityCatalog] = useState<Capability[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
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

  const updateStatus = async () => {
    const next: AgentStatus = agentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
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
      setSaved(true);
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
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Unable to save AI agent settings.");
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
          <label className="agentGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, or anything..." /><kbd>⌘ K</kbd></label>
          <div className="agentTopActions">
            <Link className="agentOnlinePill" href="/settings">Phone &amp; Messaging settings</Link>
          </div>
        </header>

        <div className="agentBody">
          <div className="agentTitleRow">
            <div><h1>AI Agent</h1><p>Configure, train and test your AI agent.</p></div>
            <div className="agentTitleActions"><span className={`agentState ${agentStatus === "ACTIVE" ? "online" : "paused"}`}><i />{loadingSettings ? "Loading status…" : `Agent ${agentStatus.toLowerCase()}`}</span><button type="button" disabled={savingSettings || loadingSettings || !canManage} onClick={() => void saveChanges()}>{savingSettings ? "Saving…" : saved ? "Saved" : "Save changes"}</button></div>
          </div>

          {settingsError && <div className="agentSettingsError">{settingsError}</div>}
          <div className="agentTabs" role="tablist" aria-label="AI Agent sections">
            {(["overview", "knowledge", "behavior", "capabilities", "test"] as AgentTab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
          </div>

          {tab === "overview" && <OverviewTab agentName={assistantName} status={agentStatus} onStatusChange={updateStatus} canManage={canManage} loading={loadingSettings || savingSettings} setTab={setTab} />}
          {tab === "knowledge" && <KnowledgeTab counts={knowledgeCounts} />}
          {tab === "behavior" && <BehaviorTab tone={tone} setTone={setTone} goal={goal} setGoal={setGoal} whenUnsure={whenUnsure} setWhenUnsure={setWhenUnsure} verbosity={verbosity} setVerbosity={setVerbosity} guardrails={guardrails} setGuardrails={setGuardrails} assistantName={assistantName} setAssistantName={setAssistantName} openingMessage={openingMessage} setOpeningMessage={setOpeningMessage} escalationMessage={escalationMessage} setEscalationMessage={setEscalationMessage} voiceProfile={voiceProfile} setVoiceProfile={setVoiceProfile} voiceLanguage={voiceLanguage} setVoiceLanguage={setVoiceLanguage} voiceSpeed={voiceSpeed} setVoiceSpeed={setVoiceSpeed} recordingPolicy={recordingPolicy} setRecordingPolicy={setRecordingPolicy} afterHoursEnabled={afterHoursEnabled} setAfterHoursEnabled={setAfterHoursEnabled} qualificationEnabled={qualificationEnabled} setQualificationEnabled={setQualificationEnabled} qualificationCriteria={qualificationCriteria} setQualificationCriteria={setQualificationCriteria} />}
          {tab === "capabilities" && <CapabilitiesTab catalog={capabilityCatalog} capabilities={capabilities} setCapabilities={setCapabilities} onSave={saveCapabilities} loading={loadingSettings || savingSettings} canManage={canManage} />}
          {tab === "test" && <TestTab />}
        </div>
      </section>
    </main>
  );
}

function OverviewTab({ agentOnline, setAgentOnline, channels, setChannels, setTab }: { agentOnline: boolean; setAgentOnline: (value: boolean) => void; channels: Record<Channel, boolean>; setChannels: (value: Record<Channel, boolean>) => void; setTab: (tab: AgentTab) => void }) {
  return (
    <div className="agentTabContent">
      <section className="overviewTopGrid">
        <article className="agentHeroCard">
          <div className="agentBotAvatar"><BotFaceIcon /></div>
          <div className="agentHeroCopy"><div className="agentHeroName"><h2>Juvi AI</h2><span><i />Online</span></div><p>Your AI agent is ready to assist customers across all channels.</p><p>Juvi AI answers questions, books appointments, provides product information and captures leads — 24/7.</p><div className="agentHeroButtons"><button type="button" onClick={() => setAgentOnline(!agentOnline)}>{agentOnline ? <PauseIcon /> : <PlayIcon />}{agentOnline ? "Pause agent" : "Resume agent"}</button><button type="button" onClick={() => setTab("behavior")}><GearIcon size={16} />Edit settings</button></div></div>
        </article>

        <article className="agentCard channelCard"><h3>Channels</h3><div className="channelRows">{(["WhatsApp", "Phone", "SMS", "Web Chat"] as Channel[]).map((channel) => <div className="channelRow" key={channel}><span className={`channelIcon ${channelClass(channel)}`}>{channelIcon(channel)}</span><strong>{channel === "Phone" ? "Phone calls" : channel}</strong><em>{channels[channel] ? "Active" : "Off"}</em><button type="button" className={`switch ${channels[channel] ? "on" : ""}`} onClick={() => setChannels({ ...channels, [channel]: !channels[channel] })}><i /></button></div>)}</div></article>

        <article className="agentCard quickActionsCard"><h3>Quick actions</h3><button type="button" onClick={() => setTab("knowledge")}><span><DocumentIcon /></span><div><strong>Update knowledge</strong><small>Add or edit business information</small></div><b>›</b></button><button type="button" onClick={() => setTab("test")}><span><MessageIcon size={16} /></span><div><strong>Test your agent</strong><small>Start a conversation</small></div><b>›</b></button><Link href="/inbox"><span><MessageIcon size={16} /></span><div><strong>View conversations</strong><small>See recent interactions</small></div><b>›</b></Link><button type="button" onClick={() => setTab("behavior")}><span><GearIcon size={16} /></span><div><strong>Agent settings</strong><small>Voice, personality and more</small></div><b>›</b></button></article>
      </section>

      <section className="agentMetricGrid">
        <Metric icon={<MessageIcon size={20} />} label="Conversations" value="248" change="↑ 12%" />
        <Metric icon={<CalendarIcon size={20} />} label="Appointments booked" value="37" change="↑ 23%" />
        <Metric icon={<UsersIcon size={20} />} label="Leads captured" value="92" change="↑ 18%" />
        <Metric icon={<StarIcon />} label="Customer satisfaction" value="4.8 / 5" change="↑ 6%" tone="gold" />
      </section>

      <section className="agentAnalyticsGrid">
        <article className="agentCard conversationChart"><div className="agentCardHeader"><h3>Conversations over time</h3><button type="button">Last 7 days <ChevronDown /></button></div><div className="chartLegendRow"><span className="wa">WhatsApp</span><span className="phone">Phone</span><span className="sms">SMS</span><span className="chat">Web Chat</span></div><div className="stackedBars">{[40,48,52,56,42,53,60].map((height, index) => <div className="stackColumn" key={height + index}><span className="web" style={{ height: `${Math.round(height * .18)}px` }} /><span className="sms" style={{ height: `${Math.round(height * .16)}px` }} /><span className="phone" style={{ height: `${Math.round(height * .30)}px` }} /><span className="wa" style={{ height: `${Math.round(height * .36)}px` }} /><small>Sep {8 + index}</small></div>)}</div></article>
        <article className="agentCard outcomesCard"><h3>Conversation outcomes</h3><div className="outcomesBody"><div className="outcomeDonut"><div><strong>248</strong><span>Total</span></div></div><div className="outcomeLegend"><span><i className="green" />Appointments booked <b>37</b></span><span><i className="blue" />Product inquiries <b>96</b></span><span><i className="purple" />General questions <b>67</b></span><span><i className="gray" />Other <b>48</b></span></div></div></article>
      </section>

      <section className="agentBottomGrid">
        <article className="agentCard recentConversationsCard"><div className="agentCardHeader"><h3>Recent conversations</h3><Link href="/inbox">View all</Link></div><div className="recentConversationTable"><div className="recentHeader"><span>Contact</span><span>Channel</span><span>Message</span><span>Outcome</span><span>Time</span><span /></div>{recentConversations.map((item) => <div className="recentRow" key={item.name}><div className="recentIdentity"><span>{item.initials}</span><strong>{item.name}</strong></div><span className={`miniChannel ${channelClass(item.channel)}`}>{channelIcon(item.channel)}</span><p>{item.message}</p><em>{item.outcome}</em><time>{item.time}</time><b>•••</b></div>)}</div></article>
        <article className="agentCard topQuestionsCard"><div className="agentCardHeader"><h3>Top questions</h3><button type="button">View all</button></div>{["Do you have ginger shots in stock?","How much does it cost?","Can I book an appointment?","What are the ingredients?","Do you deliver to Lagos?"].map((question, index) => <div className="questionRow" key={question}><span>{index + 1}</span><strong>{question}</strong><i><b style={{ width: `${88 - index * 10}%` }} /></i><em>{[32,28,24,18,16][index]}</em></div>)}</article>
      </section>
    </div>
  );
}

function KnowledgeTab() {
  const [expanded, setExpanded] = useState<number | null>(0);
  const [website, setWebsite] = useState("www.brightsideautospa.com");
  return (
    <div className="agentTabContent knowledgeLayout">
      <section className="agentCard knowledgeMainCard">
        <div className="sectionTitle"><div><h2>Knowledge</h2><p>Information your AI can use when answering customers.</p></div><button type="button">＋ Add knowledge</button></div>
        <div className="knowledgeList">{knowledgeItems.map((item, index) => <article key={item.title} className={`knowledgeItem ${expanded === index ? "open" : ""}`}><button type="button" onClick={() => setExpanded(expanded === index ? null : index)}><span className="knowledgeIcon">{item.icon}</span><div><strong>{item.title}</strong><small>{item.subtitle}</small></div><em>{item.state}</em><b>{expanded === index ? "⌃" : "⌄"}</b></button>{expanded === index && <div className="knowledgeExpanded">{index === 0 && <><label>Business summary<textarea defaultValue="Brightside Auto Spa is a Miami-based auto detailing shop focused on exterior washes, full detailing and ceramic coating." /></label><div className="inlineFields"><label>Business hours<input defaultValue="Mon–Sat, 8:00 AM–6:00 PM" /></label><label>Service area<input defaultValue="Miami + 20 miles" /></label></div></>}{index === 1 && <div className="websiteImport"><input value={website} onChange={(event) => setWebsite(event.target.value)} /><button type="button">Refresh website</button></div>}{index === 2 && <div className="miniKnowledgeRows"><span>Exterior Wash <b>Starts at $25</b></span><span>Full Detailing <b>Starts at $120</b></span><span>Ceramic Coating <b>By quote</b></span></div>}{index === 3 && <div className="miniKnowledgeRows"><span>Do you offer same-day appointments?<b>Yes, when availability allows.</b></span><span>How long does full detailing take?<b>Usually 2–4 hours.</b></span><span>Do you accept walk-ins?<b>Appointments are recommended.</b></span></div>}{index === 4 && <div className="documentGrid"><span>services.pdf <b>PDF</b></span><span>pricing.docx <b>DOCX</b></span><span>policies.txt <b>TXT</b></span><span>faq.pdf <b>PDF</b></span></div>}</div>}</article>)}</div>
      </section>

      <aside className="knowledgeSideColumn">
        <article className="agentCard knowledgeHealth"><h3>Knowledge health</h3><div className="knowledgeScore"><strong>92%</strong><span>Ready</span></div><div className="healthRows"><span><i className="ok">✓</i>Business details <b>Complete</b></span><span><i className="ok">✓</i>Services <b>3 added</b></span><span><i className="ok">✓</i>FAQs <b>12 added</b></span><span><i className="warn">!</i>Pricing <b>Review</b></span></div></article>
        <article className="agentCard uploadKnowledge"><h3>Upload documents</h3><div className="uploadDrop"><DocumentIcon /><strong>Choose files</strong><span>PDF, DOCX or TXT</span></div></article>
        <article className="agentCard syncCard"><h3>Auto-sync</h3><div className="syncRow"><div><strong>Website changes</strong><small>Keep imported content up to date.</small></div><span className="switch on"><i /></span></div></article>
      </aside>
    </div>
  );
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
        <article className="agentCard livePreview"><h3>Preview</h3><div className="previewChat"><span className="previewCustomer">How much is a full detailing?</span><span className="previewAgent">Full detailing starts at $120. The final price depends on vehicle size and condition. Would you like me to check availability?</span></div></article>
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
        body: JSON.stringify({ message: value, reset: resetNext, clientMessageId: crypto.randomUUID() }),
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
        <article className="agentCard testChecklist"><h3>Test checklist</h3><ChecklistItem label="Business questions" status={messages.length > 1 ? "Tested" : "Ready"} /><ChecklistItem label="Lead qualification" status={lastResult ? "Observed" : "Ready"} /><ChecklistItem label="Calendar availability" status={lastResult?.toolResult.kind === "availability" ? "Tested" : "Ready"} /><ChecklistItem label="Appointment booking" status="Safe simulation" /><ChecklistItem label="Human escalation" status="Safe simulation" /></article>
        <article className="agentCard testInsight"><h3>AI response details</h3><span><small>Channel</small><strong>{channel}</strong></span><span><small>Action</small><strong>{actionLabel}</strong></span><span><small>Server tool</small><strong>{toolLabel}</strong></span><span><small>Side effects</small><strong>{lastResult?.simulated ? "Simulated in Test" : "Normal test behavior"}</strong></span></article>
        <article className="agentCard readinessCard" style={{ display: "block" }}><div style={{ width: "100%" }}><strong>Web Chat embed code</strong><p>Paste this script before the closing &lt;/body&gt; tag on your website.</p><code style={{ display: "block", marginTop: 10, padding: 10, borderRadius: 8, background: "#f5f7fb", color: "#26344d", fontSize: 11, lineHeight: 1.45, overflowWrap: "anywhere" }}>{embedCode || "Loading embed code…"}</code><button type="button" onClick={() => void copyEmbed()} disabled={!embedCode} style={{ marginTop: 10 }}>{copied ? "Copied" : "Copy embed code"}</button></div></article>
      </aside>
    </div>
  );
}

function Metric({ icon, label, value, change, tone = "blue" }: { icon: React.ReactNode; label: string; value: string; change: string; tone?: string }) { return <article className="agentCard agentMetric"><span className={`metricArt ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{change}</em><p>vs last 7 days</p></div></article>; }
function GuardrailRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="guardrailRow"><span>{label}</span><button type="button" className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><i /></button></div>; }
function ChecklistItem({ label, status }: { label: string; status: string }) { return <div className="checklistItem"><span>✓</span><strong>{label}</strong><em>{status}</em></div>; }
function channelClass(channel: Channel) { return channel.toLowerCase().replace(/\s+/g, "-"); }
function channelIcon(channel: Channel) { if (channel === "Phone") return <PhoneIcon size={15} />; if (channel === "WhatsApp") return <WhatsAppIcon />; return <MessageIcon size={15} />; }

function SearchIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function ChevronDown() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>; }
function WhatsAppIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4.1A8 8 0 1 1 20 11.5Z"/><path d="M8.5 8.5c.8 2.4 2.4 4 4.8 4.8"/></svg>; }
function BuildingIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M18 13h.01M18 17h.01"/></svg>; }
function LinkIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg>; }
function ListIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>; }
function QuestionIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.2.9-1.2 1.8M12 17h.01"/></svg>; }
function DocumentIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></svg>; }
function PauseIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>; }
function PlayIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7Z"/></svg>; }
function StarIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.7-4.6 6.5-.9Z"/></svg>; }
function BotFaceIcon() { return <svg width="52" height="52" viewBox="0 0 64 64" fill="none"><rect x="10" y="18" width="44" height="34" rx="12" fill="#173c86"/><rect x="16" y="24" width="32" height="22" rx="8" fill="#f4f8ff"/><circle cx="26" cy="34" r="3" fill="#173c86"/><circle cx="38" cy="34" r="3" fill="#173c86"/><path d="M25 41h14" stroke="#173c86" strokeWidth="3" strokeLinecap="round"/><path d="M32 18v-7" stroke="#173c86" strokeWidth="4" strokeLinecap="round"/><circle cx="32" cy="8" r="4" fill="#173c86"/></svg>; }
function SendIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>; }
