"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  CalendarIcon,
  ClockIcon,
  DatabaseIcon,
  GearIcon,
  HelpIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./automations.css";

type AutomationId = "missed" | "new-lead" | "confirmation" | "reminder" | "escalation";
type Automation = {
  id: AutomationId;
  title: string;
  description: string;
  detail: string;
  metric: string;
  metricLabel: string;
  tone: string;
  channels: string[];
};

const automations: Automation[] = [
  { id: "missed", title: "Missed inquiry recovery", description: "Follow up with unanswered inquiries to re-engage potential customers.", detail: "Sends a follow-up when an inquiry has not received a response.", metric: "312", metricLabel: "recovered", tone: "red", channels: ["WhatsApp", "SMS", "Web Chat"] },
  { id: "new-lead", title: "New lead response", description: "Automatically respond to new inquiries with a personalised message.", detail: "Sends an instant response when a new lead reaches out.", metric: "1,248", metricLabel: "sent", tone: "blue", channels: ["WhatsApp", "SMS", "Web Chat"] },
  { id: "confirmation", title: "Appointment confirmation", description: "Send confirmation messages when an appointment is booked.", detail: "Confirms the appointment and shares the booking details.", metric: "486", metricLabel: "sent", tone: "green", channels: ["WhatsApp", "SMS", "Web Chat"] },
  { id: "reminder", title: "Appointment reminder", description: "Send reminder messages before an upcoming appointment.", detail: "Sends automated reminders at your chosen time.", metric: "462", metricLabel: "sent", tone: "orange", channels: ["WhatsApp", "SMS"] },
  { id: "escalation", title: "Human escalation", description: "Automatically escalate conversations to your team when needed.", detail: "Routes urgent or complex conversations to a human.", metric: "87", metricLabel: "escalated", tone: "purple", channels: ["In-app", "SMS"] },
];

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon />, active: true },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

export default function AutomationsPage() {
  const [selectedId, setSelectedId] = useState<AutomationId | null>("new-lead");
  const [enabled, setEnabled] = useState<Record<AutomationId, boolean>>({ missed: true, "new-lead": true, confirmation: true, reminder: true, escalation: true });
  const [saved, setSaved] = useState(false);
  const selected = useMemo(() => automations.find((item) => item.id === selectedId) ?? null, [selectedId]);

  return (
    <main className="appShell automationShell">
      <aside className="appSidebar automationSidebar">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}>
              <span className="appNavIcon">{item.icon}</span><span>{item.label}</span>{item.badge && <b className="navBadge">{item.badge}</b>}
            </Link>
          ))}
        </nav>
        <a className="automationHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace automationWorkspace">
        <header className="automationTopbar">
          <label className="automationGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, or settings..." /><kbd>⌘ K</kbd></label>
          <div className="automationTopActions">
            <button className="automationAgent" type="button"><i />AI Agent Online <ChevronDown /></button>
            <button className="automationCredit" type="button"><MessageIcon size={15} />2,480 credits</button>
            <button className="automationBell" type="button" aria-label="Notifications">♧<i /></button>
            <div className="profileBlock automationProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className={`automationBody ${selected ? "drawerOpen" : ""}`}>
          <div className="automationTitleRow">
            <div><h1>Automations</h1><p>Automated responses and follow-ups for common customer events.</p></div>
            <button type="button" className="activityLogButton"><ClockIcon size={16} />View activity log</button>
          </div>

          <section className="automationList">
            {automations.map((automation) => (
              <article key={automation.id} className={`automationCard ${selectedId === automation.id ? "selected" : ""}`} onClick={() => { setSelectedId(automation.id); setSaved(false); }}>
                <span className={`automationIcon ${automation.tone}`}><WorkflowIcon id={automation.id} /></span>
                <div className="automationCopy"><div className="automationNameRow"><h2>{automation.title}</h2>{enabled[automation.id] && <span className="activePill">Active</span>}</div><p>{automation.description}</p><small>{automation.detail}</small><div className="automationChannels">{automation.channels.map((channel) => <ChannelPill key={channel} channel={channel} />)}</div></div>
                <div className="automationControls">
                  <button type="button" className={`switch ${enabled[automation.id] ? "on" : ""}`} aria-label={`${enabled[automation.id] ? "Disable" : "Enable"} ${automation.title}`} onClick={(event) => { event.stopPropagation(); setEnabled((current) => ({ ...current, [automation.id]: !current[automation.id] })); }}><i /></button>
                  <button type="button" className="editAutomation" onClick={(event) => { event.stopPropagation(); setSelectedId(automation.id); setSaved(false); }}>Edit</button>
                  <span className="automationChevron">›</span>
                </div>
                <div className="automationMetric"><strong>{automation.metric} {automation.metricLabel}</strong><small>Last 30 days</small></div>
              </article>
            ))}
          </section>
        </div>

        {selected && <AutomationDrawer automation={selected} enabled={enabled[selected.id]} onClose={() => setSelectedId(null)} onToggle={() => setEnabled((current) => ({ ...current, [selected.id]: !current[selected.id] }))} saved={saved} onSave={() => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }} />}
      </section>
    </main>
  );
}

function AutomationDrawer({ automation, enabled, onClose, onToggle, saved, onSave }: { automation: Automation; enabled: boolean; onClose: () => void; onToggle: () => void; saved: boolean; onSave: () => void }) {
  return <aside className="automationDrawer" aria-label={`${automation.title} settings`}>
    <button type="button" className="drawerClose" onClick={onClose}>×</button>
    <header className="drawerHeader"><span className={`automationIcon ${automation.tone}`}><WorkflowIcon id={automation.id} /></span><div><div className="drawerTitleLine"><h2>{automation.title}</h2><span className={enabled ? "activePill" : "inactivePill"}>{enabled ? "Active" : "Paused"}</span></div><p>{automation.description}</p></div></header>
    <div className="drawerEnableRow"><span>Automation enabled</span><button type="button" className={`switch ${enabled ? "on" : ""}`} onClick={onToggle}><i /></button></div>
    <AutomationSettings id={automation.id} />
    <footer className="drawerFooter"><button type="button" className="cancelSettings" onClick={onClose}>Cancel</button><button type="button" className="saveAutomation" onClick={onSave}>{saved ? "Saved" : "Save changes"}</button></footer>
  </aside>;
}

function AutomationSettings({ id }: { id: AutomationId }) {
  const [followUp, setFollowUp] = useState(id === "new-lead" || id === "missed" || id === "reminder");
  const [channels, setChannels] = useState<Record<string, boolean>>({ WhatsApp: true, SMS: true, "Web Chat": id !== "reminder", Phone: false, "In-app": true });
  const toggleChannel = (name: string) => setChannels((current) => ({ ...current, [name]: !current[name] }));

  if (id === "new-lead") return <>
    <SettingsSection title="Basic settings"><Field label="Response delay"><select defaultValue="now"><option value="now">Send immediately</option><option>1 minute</option><option>5 minutes</option></select></Field><ChannelsGrid names={["WhatsApp","SMS","Web Chat","Phone"]} values={channels} onToggle={toggleChannel} /></SettingsSection>
    <MessageSection title="Message content" defaultValue={"Hi {{name}}! 👋\n\nThanks for reaching out to {{business_name}}. I’m Juvi AI and I’m here to help. How can I assist you today?"} />
    <SettingsSection title="Follow-up (if no response)" action={<button type="button" className={`switch ${followUp ? "on" : ""}`} onClick={() => setFollowUp(!followUp)}><i /></button>}><Field label="Send follow-up after"><select defaultValue="24"><option value="24">24 hours</option><option>2 hours</option><option>48 hours</option></select></Field><textarea className="automationTextarea compact" defaultValue={"Just checking in, {{name}} 🙂\n\nDo you still need any help? I’m happy to assist you!"} /></SettingsSection>
  </>;

  if (id === "missed") return <>
    <SettingsSection title="Recovery settings"><Field label="Wait before follow-up"><select defaultValue="15"><option value="15">15 minutes</option><option>30 minutes</option><option>1 hour</option></select></Field><Field label="Maximum attempts"><select defaultValue="2"><option value="2">2 attempts</option><option>1 attempt</option><option>3 attempts</option></select></Field><ChannelsGrid names={["WhatsApp","SMS","Web Chat"]} values={channels} onToggle={toggleChannel} /></SettingsSection>
    <MessageSection title="Recovery message" defaultValue={"Hi {{name}}, we noticed we missed your message. I’m here now and can help with your question or booking."} />
    <SettingsSection title="Second attempt" action={<button type="button" className={`switch ${followUp ? "on" : ""}`} onClick={() => setFollowUp(!followUp)}><i /></button>}><Field label="Send after"><select defaultValue="24"><option value="24">24 hours</option><option>6 hours</option><option>48 hours</option></select></Field></SettingsSection>
  </>;

  if (id === "confirmation") return <>
    <SettingsSection title="Confirmation settings"><Field label="Send"><select><option>Immediately after booking</option><option>5 minutes after booking</option></select></Field><ChannelsGrid names={["WhatsApp","SMS","Web Chat"]} values={channels} onToggle={toggleChannel} /></SettingsSection>
    <MessageSection title="Confirmation message" defaultValue={"You’re booked, {{name}}. Your {{service}} appointment is confirmed for {{appointment_date}} at {{appointment_time}}."} />
    <SettingsSection title="Include booking details"><CheckRow label="Date and time" checked /><CheckRow label="Location or meeting link" checked /><CheckRow label="Reschedule link" checked /></SettingsSection>
  </>;

  if (id === "reminder") return <>
    <SettingsSection title="Reminder timing"><Field label="First reminder"><select><option>24 hours before</option><option>12 hours before</option><option>2 hours before</option></select></Field><ChannelsGrid names={["WhatsApp","SMS"]} values={channels} onToggle={toggleChannel} /></SettingsSection>
    <MessageSection title="Reminder message" defaultValue={"Reminder: your {{service}} appointment is tomorrow at {{appointment_time}}. Reply here if you need to reschedule."} />
    <SettingsSection title="Second reminder" action={<button type="button" className={`switch ${followUp ? "on" : ""}`} onClick={() => setFollowUp(!followUp)}><i /></button>}><Field label="Send"><select><option>2 hours before</option><option>1 hour before</option><option>30 minutes before</option></select></Field></SettingsSection>
  </>;

  return <>
    <SettingsSection title="Escalate when"><CheckRow label="Customer asks for a human" checked /><CheckRow label="AI confidence is low" checked /><CheckRow label="Complaint or urgent issue" checked /><CheckRow label="Special pricing request" checked /></SettingsSection>
    <SettingsSection title="Notify team"><ChannelsGrid names={["In-app","SMS"]} values={channels} onToggle={toggleChannel} /><Field label="Escalation timeout"><select><option>Immediately</option><option>After 2 minutes</option><option>After 5 minutes</option></select></Field></SettingsSection>
    <MessageSection title="Customer handoff message" defaultValue={"I’m connecting you with a member of the team who can help with this. Please hold for a moment."} />
  </>;
}

function SettingsSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className="automationSettingsSection"><div className="settingsSectionHeading"><h3>{title}</h3>{action}</div>{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="automationField"><span>{label}</span>{children}</label>; }
function ChannelsGrid({ names, values, onToggle }: { names: string[]; values: Record<string, boolean>; onToggle: (name: string) => void }) { return <div className="channelsSetting"><span className="fieldLabel">Channels</span><div className="channelChecks">{names.map((name) => <label key={name}><input type="checkbox" checked={!!values[name]} onChange={() => onToggle(name)} />{name}</label>)}</div></div>; }
function CheckRow({ label, checked = false }: { label: string; checked?: boolean }) { return <label className="simpleCheck"><input type="checkbox" defaultChecked={checked} />{label}</label>; }
function MessageSection({ title, defaultValue }: { title: string; defaultValue: string }) { const [preview, setPreview] = useState(false); return <section className="automationSettingsSection"><div className="settingsSectionHeading"><h3>{title}</h3><button type="button" className="textAction">Use template</button></div><div className="messageTabs"><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Message</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button></div>{preview ? <div className="messagePreview">{defaultValue.replaceAll("{{name}}", "Chioma").replaceAll("{{business_name}}", "Wellness Juvi").replaceAll("{{service}}", "Consultation").replaceAll("{{appointment_date}}", "Sep 18").replaceAll("{{appointment_time}}", "10:00 AM")}</div> : <textarea className="automationTextarea" defaultValue={defaultValue} />}<small className="variableHint">Variables: {"{{name}}"}, {"{{business_name}}"}, {"{{service}}"}, appointment date/time</small></section>; }

function ChannelPill({ channel }: { channel: string }) { const icon = channel === "WhatsApp" ? "◉" : channel === "SMS" ? "▣" : channel === "Web Chat" ? "▤" : channel === "In-app" ? "♢" : "◌"; return <span className={`workflowChannel ${slug(channel)}`}><b>{icon}</b>{channel}</span>; }
function WorkflowIcon({ id }: { id: AutomationId }) { if (id === "missed") return <RefreshIcon />; if (id === "new-lead") return <MessageIcon size={21} />; if (id === "confirmation") return <CalendarIcon size={21} />; if (id === "reminder") return <ClockIcon size={21} />; return <UsersIcon size={21} />; }
function slug(value: string) { return value.toLowerCase().replace(/\s+/g, "-"); }
function HomeIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>}
function BotIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>}
function BoltIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>}
function SearchIcon(){return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>}
function ChevronDown(){return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6"/></svg>}
function RefreshIcon(){return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M18 16a7 7 0 0 1-11.9 0L4 12"/></svg>}
