"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CalendarIcon,
  DatabaseIcon,
  GearIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./ai-agent.css";

type AgentTab = "overview" | "knowledge" | "behavior" | "test";
type Channel = "WhatsApp" | "Phone" | "SMS" | "Web Chat";

type TestMessage = {
  id: number;
  role: "customer" | "agent";
  text: string;
};

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon />, active: true },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

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

const defaultMessages: TestMessage[] = [
  { id: 1, role: "customer", text: "Hi, do you have ginger shots in stock?" },
  { id: 2, role: "agent", text: "Yes. We currently have Juvi ginger shots available. A pack of 10 is ₦12,500 and delivery is available in Lagos." },
  { id: 3, role: "customer", text: "Can I book a consultation for tomorrow?" },
  { id: 4, role: "agent", text: "Absolutely. I can help with that. I have openings at 10:00 AM, 1:30 PM and 3:00 PM. Which works best for you?" },
];

export default function AIAgentPage() {
  const [tab, setTab] = useState<AgentTab>("overview");
  const [agentOnline, setAgentOnline] = useState(true);
  const [saved, setSaved] = useState(false);
  const [channels, setChannels] = useState<Record<Channel, boolean>>({ WhatsApp: true, Phone: true, SMS: true, "Web Chat": true });
  const [tone, setTone] = useState("Friendly & professional");
  const [goal, setGoal] = useState("Book appointments");
  const [whenUnsure, setWhenUnsure] = useState("Escalate to a human");
  const [verbosity, setVerbosity] = useState("Concise");
  const [guardrails, setGuardrails] = useState({ pricing: true, availability: true, approvedInfo: true, collectContact: true });
  const [testChannel, setTestChannel] = useState<Channel>("Web Chat");
  const [testMessages, setTestMessages] = useState<TestMessage[]>(defaultMessages);
  const [testInput, setTestInput] = useState("");

  const saveChanges = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const sendTestMessage = () => {
    const value = testInput.trim();
    if (!value) return;
    const customerMessage: TestMessage = { id: Date.now(), role: "customer", text: value };
    const response: TestMessage = { id: Date.now() + 1, role: "agent", text: "I can help with that. Based on your business information, I can answer the question or help book the next available appointment." };
    setTestMessages((current) => [...current, customerMessage, response]);
    setTestInput("");
  };

  return (
    <main className="appShell agentShell">
      <aside className="appSidebar agentSidebar">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}>
              <span className="appNavIcon">{item.icon}</span>
              <span>{item.label}</span>
              {item.badge && <b className="navBadge">{item.badge}</b>}
            </Link>
          ))}
        </nav>
      </aside>

      <section className="appWorkspace agentWorkspace">
        <header className="agentTopbar">
          <label className="agentGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, or anything..." /><kbd>⌘ K</kbd></label>
          <div className="agentTopActions">
            <button className="agentOnlinePill" type="button"><i />AI Agent Online <ChevronDown /></button>
            <button className="agentCredits" type="button"><MessageIcon size={15} />2,480 credits</button>
            <button className="agentBell" type="button" aria-label="Notifications">♧<i /></button>
            <div className="profileBlock agentProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className="agentBody">
          <div className="agentTitleRow">
            <div><h1>AI Agent</h1><p>Configure, train and test your AI agent.</p></div>
            <div className="agentTitleActions"><span className={`agentState ${agentOnline ? "online" : "paused"}`}><i />{agentOnline ? "Agent Online" : "Agent Paused"}</span><button type="button" onClick={saveChanges}>{saved ? "Saved" : "Save changes"}</button></div>
          </div>

          <div className="agentTabs" role="tablist" aria-label="AI Agent sections">
            {(["overview", "knowledge", "behavior", "test"] as AgentTab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
          </div>

          {tab === "overview" && <OverviewTab agentOnline={agentOnline} setAgentOnline={setAgentOnline} channels={channels} setChannels={setChannels} setTab={setTab} />}
          {tab === "knowledge" && <KnowledgeTab />}
          {tab === "behavior" && <BehaviorTab tone={tone} setTone={setTone} goal={goal} setGoal={setGoal} whenUnsure={whenUnsure} setWhenUnsure={setWhenUnsure} verbosity={verbosity} setVerbosity={setVerbosity} guardrails={guardrails} setGuardrails={setGuardrails} />}
          {tab === "test" && <TestTab channel={testChannel} setChannel={setTestChannel} messages={testMessages} input={testInput} setInput={setTestInput} onSend={sendTestMessage} />}
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

function BehaviorTab({ tone, setTone, goal, setGoal, whenUnsure, setWhenUnsure, verbosity, setVerbosity, guardrails, setGuardrails }: { tone: string; setTone: (value: string) => void; goal: string; setGoal: (value: string) => void; whenUnsure: string; setWhenUnsure: (value: string) => void; verbosity: string; setVerbosity: (value: string) => void; guardrails: { pricing: boolean; availability: boolean; approvedInfo: boolean; collectContact: boolean }; setGuardrails: (value: { pricing: boolean; availability: boolean; approvedInfo: boolean; collectContact: boolean }) => void }) {
  return (
    <div className="agentTabContent behaviorLayout">
      <section className="behaviorMain">
        <article className="agentCard behaviorCard"><div className="sectionTitle compact"><div><h2>Identity & voice</h2><p>How your AI should sound.</p></div></div><div className="behaviorFields two"><label>Assistant name<input defaultValue="Juvi AI" /></label><label>Tone<select value={tone} onChange={(event) => setTone(event.target.value)}><option>Friendly & professional</option><option>Warm & casual</option><option>Direct & concise</option><option>Formal</option></select></label><label>Primary goal<select value={goal} onChange={(event) => setGoal(event.target.value)}><option>Book appointments</option><option>Qualify leads</option><option>Answer questions</option><option>Capture contact details</option></select></label><label>Response length<select value={verbosity} onChange={(event) => setVerbosity(event.target.value)}><option>Concise</option><option>Balanced</option><option>Detailed</option></select></label></div></article>

        <article className="agentCard behaviorCard"><div className="sectionTitle compact"><div><h2>Conversation behavior</h2><p>What the AI should do in common situations.</p></div></div><div className="behaviorFields"><label>When unsure<select value={whenUnsure} onChange={(event) => setWhenUnsure(event.target.value)}><option>Escalate to a human</option><option>Ask a clarifying question</option><option>Collect details for follow-up</option></select></label><label>Opening message<textarea defaultValue="Hi! I'm Juvi AI. How can I help you today?" /></label><label>Escalation message<textarea defaultValue="I want to make sure you get the right answer. Let me connect you with a member of the team." /></label></div></article>

        <article className="agentCard behaviorCard"><div className="sectionTitle compact"><div><h2>Guardrails</h2><p>Rules the AI must always follow.</p></div></div><div className="guardrailRows"><GuardrailRow label="Never invent pricing" checked={guardrails.pricing} onChange={(value) => setGuardrails({ ...guardrails, pricing: value })} /><GuardrailRow label="Never confirm unavailable appointments" checked={guardrails.availability} onChange={(value) => setGuardrails({ ...guardrails, availability: value })} /><GuardrailRow label="Only answer from approved business information" checked={guardrails.approvedInfo} onChange={(value) => setGuardrails({ ...guardrails, approvedInfo: value })} /><GuardrailRow label="Collect customer name and contact before handoff" checked={guardrails.collectContact} onChange={(value) => setGuardrails({ ...guardrails, collectContact: value })} /></div></article>
      </section>

      <aside className="behaviorSide">
        <article className="agentCard livePreview"><h3>Preview</h3><div className="previewChat"><span className="previewCustomer">How much is a full detailing?</span><span className="previewAgent">Full detailing starts at $120. The final price depends on vehicle size and condition. Would you like me to check availability?</span></div></article>
        <article className="agentCard behaviorSummary"><h3>Current behavior</h3><span><small>Tone</small><strong>{tone}</strong></span><span><small>Goal</small><strong>{goal}</strong></span><span><small>When unsure</small><strong>{whenUnsure}</strong></span><span><small>Response length</small><strong>{verbosity}</strong></span></article>
      </aside>
    </div>
  );
}

function TestTab({ channel, setChannel, messages, input, setInput, onSend }: { channel: Channel; setChannel: (channel: Channel) => void; messages: TestMessage[]; input: string; setInput: (value: string) => void; onSend: () => void }) {
  return (
    <div className="agentTabContent testLayout">
      <section className="agentCard testPanel">
        <div className="testHeader"><div><h2>Test your AI</h2><p>Run a sample conversation before customers see it.</p></div><button type="button" onClick={() => window.location.reload()}>Reset test</button></div>
        <div className="testChannelTabs">{(["Web Chat", "WhatsApp", "SMS", "Phone"] as Channel[]).map((item) => <button key={item} type="button" className={channel === item ? "active" : ""} onClick={() => setChannel(item)}>{channelIcon(item)}{item}</button>)}</div>
        <div className="testConversation"><div className="testConversationTop"><span className={`testChannelIcon ${channelClass(channel)}`}>{channelIcon(channel)}</span><div><strong>Test conversation</strong><small>{channel}</small></div><em><i />AI ready</em></div><div className="testMessages">{messages.map((message) => <div key={message.id} className={`testMessage ${message.role}`}><span>{message.text}</span><small>{message.role === "agent" ? "Juvi AI" : "Test customer"}</small></div>)}</div><div className="testComposer"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSend(); }} placeholder="Type a test message..." /><button type="button" onClick={onSend}><SendIcon /></button></div></div>
      </section>

      <aside className="testSideColumn">
        <article className="agentCard testChecklist"><h3>Test checklist</h3><ChecklistItem label="Business questions" status="Passed" /><ChecklistItem label="Pricing response" status="Passed" /><ChecklistItem label="Appointment booking" status="Passed" /><ChecklistItem label="Human escalation" status="Ready" /><ChecklistItem label="Unknown question" status="Ready" /></article>
        <article className="agentCard testInsight"><h3>AI response details</h3><span><small>Knowledge used</small><strong>Services + Pricing</strong></span><span><small>Confidence</small><strong>94%</strong></span><span><small>Detected intent</small><strong>Appointment booking</strong></span><span><small>Action</small><strong>Suggested times</strong></span></article>
        <article className="agentCard readinessCard"><span className="readinessIcon">✓</span><div><strong>Ready for customers</strong><p>Your agent passed the main test scenarios.</p></div></article>
      </aside>
    </div>
  );
}

function Metric({ icon, label, value, change, tone = "blue" }: { icon: React.ReactNode; label: string; value: string; change: string; tone?: string }) { return <article className="agentCard agentMetric"><span className={`metricArt ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{change}</em><p>vs last 7 days</p></div></article>; }
function GuardrailRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="guardrailRow"><span>{label}</span><button type="button" className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><i /></button></div>; }
function ChecklistItem({ label, status }: { label: string; status: string }) { return <div className="checklistItem"><span>✓</span><strong>{label}</strong><em>{status}</em></div>; }
function channelClass(channel: Channel) { return channel.toLowerCase().replace(/\s+/g, "-"); }
function channelIcon(channel: Channel) { if (channel === "Phone") return <PhoneIcon size={15} />; if (channel === "WhatsApp") return <WhatsAppIcon />; return <MessageIcon size={15} />; }

function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
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
