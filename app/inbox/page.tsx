"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  DatabaseIcon,
  GearIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import "./inbox.css";

type Channel = "WhatsApp" | "SMS" | "Call" | "Web Chat";
type Conversation = {
  id: number;
  name: string;
  initials: string;
  preview: string;
  time: string;
  channel: Channel;
  handling: "AI handled" | "Human";
  tag?: string;
  unread?: boolean;
};

const conversations: Conversation[] = [
  { id: 1, name: "Chioma Okafor", initials: "CO", preview: "Hi, I’m interested in your ginger shots...", time: "10:24 AM", channel: "WhatsApp", handling: "AI handled", tag: "New", unread: true },
  { id: 2, name: "Tunde Adebayo", initials: "TA", preview: "Can you tell me your prices?", time: "10:17 AM", channel: "Call", handling: "Human", tag: "Needs follow-up", unread: true },
  { id: 3, name: "Sarah Johnson", initials: "SJ", preview: "I’d like to book a consultation for next...", time: "9:52 AM", channel: "Web Chat", handling: "AI handled", tag: "Qualified" },
  { id: 4, name: "Emeka Nwosu", initials: "EN", preview: "Do you deliver to Lagos?", time: "Yesterday", channel: "SMS", handling: "AI handled" },
  { id: 5, name: "Grace Wilson", initials: "GW", preview: "I missed your call", time: "Yesterday", channel: "WhatsApp", handling: "Human", tag: "Missed call" },
  { id: 6, name: "Daniel Etim", initials: "DE", preview: "Can I reschedule my appointment?", time: "Yesterday", channel: "Call", handling: "AI handled", tag: "Appointment" },
  { id: 7, name: "Amara Bello", initials: "AB", preview: "What are the ingredients in Juvi?", time: "Sep 14", channel: "Web Chat", handling: "Human" },
  { id: 8, name: "Ibrahim Musa", initials: "IM", preview: "Please send me your bank details", time: "Sep 14", channel: "SMS", handling: "AI handled" },
  { id: 9, name: "Linda James", initials: "LJ", preview: "Do you have a branch in Enugu?", time: "Sep 14", channel: "WhatsApp", handling: "AI handled" },
];

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3", active: true },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

export default function InboxPage() {
  const [activeFilter, setActiveFilter] = useState<"All" | "Unread" | "Mine" | "Starred">("All");
  const [channelFilter, setChannelFilter] = useState<"All channels" | Channel>("All channels");
  const [selectedId, setSelectedId] = useState(1);
  const [takeover, setTakeover] = useState(false);
  const [booked, setBooked] = useState(false);
  const selected = conversations.find((item) => item.id === selectedId) ?? conversations[0];

  const visibleConversations = conversations.filter((item) => {
    if (channelFilter !== "All channels" && item.channel !== channelFilter) return false;
    if (activeFilter === "Unread" && !item.unread) return false;
    if (activeFilter === "Mine" && item.handling !== "Human") return false;
    return true;
  });

  return (
    <main className="inboxShell">
      <aside className="appSidebar inboxSidebarNav">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}>
              <span className="appNavIcon">{item.icon}</span><span>{item.label}</span>{item.badge && <b className="navBadge">{item.badge}</b>}
            </Link>
          ))}
        </nav>
        <a className="sidebarHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={19} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="inboxWorkspace">
        <header className="inboxTopbar">
          <div className="globalSearch"><SearchIcon /><input placeholder="Search conversations, contacts or messages..." /><kbd>⌘ K</kbd></div>
          <div className="inboxTopActions">
            <button type="button" className="agentOnline"><i />AI Agent Online <ChevronDown /></button>
            <button type="button" className="creditsButton"><MessageIcon size={16} />2,480 credits</button>
            <button type="button" className="bellButton"><BellIcon /><i /></button>
            <div className="profileBlock"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className="unifiedInboxGrid">
          <section className="conversationColumn">
            <div className="conversationColumnHeader"><h1>Inbox</h1><button type="button" className="composeButton">✎</button></div>
            <div className="inboxTabs">
              {(["All", "Unread", "Mine", "Starred"] as const).map((filter) => <button key={filter} type="button" className={activeFilter === filter ? "active" : ""} onClick={() => setActiveFilter(filter)}>{filter}{filter === "All" || filter === "Unread" ? <b>3</b> : null}</button>)}
            </div>
            <div className="conversationFilters">
              <label><select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as "All channels" | Channel)}><option>All channels</option><option>WhatsApp</option><option>SMS</option><option>Call</option><option>Web Chat</option></select></label>
              <label><select defaultValue="All status"><option>All status</option><option>AI handled</option><option>Human</option><option>Needs follow-up</option></select></label>
              <button type="button" className="filterButton"><FilterIcon /></button>
            </div>

            <div className="conversationList">
              {visibleConversations.map((item) => (
                <button key={item.id} type="button" className={`conversationItem ${selectedId === item.id ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
                  <span className="contactAvatar">{item.initials}</span>
                  <span className="conversationInfo">
                    <span className="conversationNameRow"><strong>{item.name}</strong><time>{item.time}</time></span>
                    <span className="conversationPreview"><ChannelGlyph channel={item.channel} />{item.preview}</span>
                    <span className="conversationTags"><ChannelBadge channel={item.channel} /><span className={`handlingBadge ${item.handling === "Human" ? "human" : "ai"}`}>{item.handling}</span>{item.tag && <span className={`smallTag ${tagTone(item.tag)}`}>{item.tag}</span>}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="threadColumn">
            <header className="threadHeader">
              <div className="threadContact"><span className="threadAvatar">{selected.initials}</span><div><strong>{selected.name}</strong><span><ChannelGlyph channel={selected.channel} /> +234 803 123 4567 &nbsp; · &nbsp; Lagos, Nigeria</span></div></div>
              <div className="threadActions"><button className={`takeoverTop ${takeover ? "active" : ""}`} type="button" onClick={() => setTakeover((value) => !value)}>{takeover ? "Return to AI" : "Human takeover"}</button><button type="button">☆</button><button type="button">Assign</button><button type="button">⋮</button></div>
            </header>

            <div className="threadBody">
              <div className="dayDivider"><span>Today</span></div>
              <CustomerMessage avatar={selected.initials} channel="WhatsApp" time="10:20 AM">Hi, I’m interested in your ginger shots.<br />Can you tell me more about the benefits?</CustomerMessage>
              <AgentMessage channel="WhatsApp" time="10:21 AM">Hi Chioma! 👋<br /><br />Our Juvi ginger shots are made with 100% natural ingredients like ginger, turmeric, citrus and more. They support immunity, digestion, and overall wellness.<br /><br />Would you like to place an order or book a consultation to learn more?</AgentMessage>
              <CallTranscript />
              <CustomerMessage avatar={selected.initials} channel="WhatsApp" time="10:23 AM">That sounds great! How much is a pack and do you deliver to Lagos?</CustomerMessage>
              <AgentMessage channel="WhatsApp" time="10:24 AM">A pack of 10 bottles is ₦12,500 and yes, we deliver to Lagos.<br /><br />Would you like me to book an order for you or would you prefer a quick consultation?</AgentMessage>
              <CustomerMessage avatar={selected.initials} channel="WhatsApp" time="10:25 AM">Let’s book a consultation for next week please.</CustomerMessage>
              <div className="quickActions"><button type="button" onClick={() => setBooked(true)}><CalendarIcon size={16} />{booked ? "Appointment booked" : "Book appointment"}</button><button type="button">◇ Share pricing</button><button type="button">▤ Send info</button><button type="button">•••</button></div>
            </div>

            <div className="composerWrap">
              <div className="composerTabs"><button className="active" type="button">Message</button><button type="button">Internal note</button></div>
              <textarea placeholder="Type a message..." />
              <div className="composerFooter"><div><button type="button">☺</button><button type="button">⌕</button><button type="button">ϟ</button></div><span>0/2000</span><button type="button" className="sendButton">➤ <ChevronDown /></button></div>
            </div>
          </section>

          <aside className="contactColumn">
            <div className="contactTabs"><button className="active" type="button">Contact</button><button type="button">Appointments (1)</button><button type="button">Notes (2)</button></div>
            <section className="contactSummary">
              <span className="largeAvatar">{selected.initials}</span><div><strong>{selected.name}</strong><span><ChannelGlyph channel={selected.channel} /> +234 803 123 4567</span><span>⌖ Lagos, Nigeria</span></div><button type="button">Edit</button>
            </section>
            <div className="contactChannelRow"><ChannelBadge channel={selected.channel} /><span className="currentChannel">Current channel</span></div>
            <InfoRows rows={[["Email","chioma@example.com"],["Phone","+234 803 123 4567"],["Location","Lagos, Nigeria"],["Source",selected.channel],["Added","Sep 15, 2025, 10:20 AM"],["Last activity","Sep 15, 2025, 10:24 AM"]]} />
            <DetailSection title="AI Insights">
              <InfoRows rows={[["Interested in","Ginger Shots"],["Intent","Product inquiry"],["Sentiment","Positive"],["Confidence","92%"]]} compact />
              <div className="insightCard"><span>✦</span><div><strong>Likely to convert</strong><p>Shows strong interest in product and delivery options.</p></div></div>
            </DetailSection>
            <DetailSection title="Custom fields"><InfoRows rows={[["Budget","Not specified"],["Preferred time","Weekdays"],["Tags","New lead · Wellness"]]} compact /></DetailSection>
            <DetailSection title="Actions">
              <div className="contactActions"><button type="button" onClick={() => setBooked(true)}><CalendarIcon size={16} />{booked ? "Appointment booked" : "Book appointment"}</button><button type="button">☑ Create task</button><button type="button">ϟ Add to automation</button><button type="button" className="danger" onClick={() => setTakeover(true)}><UsersIcon size={16} />Human takeover</button></div>
            </DetailSection>
          </aside>
        </div>
      </section>
    </main>
  );
}

function CustomerMessage({ avatar, channel, time, children }: { avatar: string; channel: Channel; time: string; children: ReactNode }) {
  return <div className="messageRow customer"><span className="miniAvatar">{avatar}</span><div className="messageBubble incoming"><div className="messageMeta"><ChannelBadge channel={channel} compact /><time>{time}</time></div><p>{children}</p></div></div>;
}
function AgentMessage({ channel, time, children }: { channel: Channel; time: string; children: ReactNode }) {
  return <div className="messageRow agent"><div className="messageBubble outgoing"><div className="messageMeta"><ChannelBadge channel={channel} compact /><time>{time}</time></div><p>{children}</p><span className="delivered">✓✓</span></div><span className="botAvatar"><BotIcon /></span></div>;
}
function CallTranscript() {
  return <div className="callTranscript"><div className="transcriptHeader"><PhoneIcon size={16} /><strong>Call transcript</strong><time>10:22 AM</time></div><div className="callPlayback"><button type="button">▶</button><div><strong>Incoming call · 2 min 14 sec</strong><span className="waveform">▁▂▃▆▄▇▃▅▂▆▇▄▃▅▇▆▂▅▃▇▅▂▃▆</span></div><a href="#transcript">View transcript</a></div><p>Outcome: Asked about pricing and delivery to Lagos.</p></div>;
}
function ChannelGlyph({ channel }: { channel: Channel }) {
  if (channel === "Call") return <PhoneIcon size={13} />;
  return <MessageIcon size={13} />;
}
function ChannelBadge({ channel, compact = false }: { channel: Channel; compact?: boolean }) {
  return <span className={`channelBadge ${channel.toLowerCase().replace(" ", "-")} ${compact ? "compact" : ""}`}><ChannelGlyph channel={channel} />{channel}</span>;
}
function InfoRows({ rows, compact = false }: { rows: Array<[string, string]>; compact?: boolean }) {
  return <div className={`infoRows ${compact ? "compact" : ""}`}>{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong className={label === "Sentiment" ? "positiveValue" : ""}>{value}</strong></div>)}</div>;
}
function DetailSection({ title, children }: { title: string; children: ReactNode }) { return <section className="detailSection"><div className="detailHeading"><strong>{title}</strong><ChevronDown /></div>{children}</section>; }
function tagTone(tag: string) { if (tag.includes("follow") || tag.includes("Missed")) return "red"; if (tag === "Qualified") return "green"; return "blue"; }

function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function ChevronDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>; }
function SearchIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function BellIcon() { return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>; }
function FilterIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M7 12h10M10 18h4"/></svg>; }
