"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  ClockIcon,
  DatabaseIcon,
  GearIcon,
  HelpIcon,
  LogoMark,
  MapPinIcon,
  MessageIcon,
  PhoneIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import "../dashboard/dashboard.css";
import "./contacts.css";

type Channel = "WhatsApp" | "Phone" | "Web Chat" | "SMS";
type LeadStatus = "Hot lead" | "New" | "Qualified" | "Nurturing" | "Customer" | "Lost" | "Qualifying";
type AppointmentStatus = "Booked" | "Not booked" | "Completed" | "Scheduled";
type Segment = "all" | "leads" | "customers" | "hot" | "inactive";

type Contact = {
  id: number;
  name: string;
  email: string;
  phone: string;
  initials: string;
  avatarTone: string;
  channel: Channel;
  leadStatus: LeadStatus;
  appointmentStatus: AppointmentStatus;
  lastInteraction: string;
  interactionType: string;
  tags: string[];
  segment: Exclude<Segment, "all">;
};

const contacts: Contact[] = [
  { id: 1, name: "Chioma Okafor", email: "chioma@example.com", phone: "+234 803 123 4567", initials: "CO", avatarTone: "rose", channel: "WhatsApp", leadStatus: "Hot lead", appointmentStatus: "Booked", lastInteraction: "10 min ago", interactionType: "AI conversation", tags: ["Ginger Shot", "Interested"], segment: "hot" },
  { id: 2, name: "Tunde Adebayo", email: "tunde@example.com", phone: "+234 805 234 5678", initials: "TA", avatarTone: "blue", channel: "Phone", leadStatus: "New", appointmentStatus: "Not booked", lastInteraction: "32 min ago", interactionType: "Missed call", tags: ["Pricing"], segment: "leads" },
  { id: 3, name: "Sarah Johnson", email: "sarah@example.com", phone: "+234 806 345 6789", initials: "SJ", avatarTone: "gold", channel: "Web Chat", leadStatus: "Qualified", appointmentStatus: "Booked", lastInteraction: "1 hour ago", interactionType: "Web chat", tags: ["Consultation", "Lagos"], segment: "leads" },
  { id: 4, name: "Emeka Onuoha", email: "emeka@example.com", phone: "+234 807 456 7890", initials: "EO", avatarTone: "slate", channel: "SMS", leadStatus: "Nurturing", appointmentStatus: "Not booked", lastInteraction: "2 hours ago", interactionType: "SMS", tags: ["Follow up"], segment: "leads" },
  { id: 5, name: "Grace Wilson", email: "grace@example.com", phone: "+234 808 567 8901", initials: "GW", avatarTone: "purple", channel: "WhatsApp", leadStatus: "Customer", appointmentStatus: "Completed", lastInteraction: "3 hours ago", interactionType: "AI conversation", tags: ["Repeat customer", "Lagos"], segment: "customers" },
  { id: 6, name: "Daniel Etim", email: "daniel@example.com", phone: "+234 809 678 9012", initials: "DE", avatarTone: "teal", channel: "Phone", leadStatus: "Lost", appointmentStatus: "Not booked", lastInteraction: "5 hours ago", interactionType: "Call ended", tags: ["Price sensitive"], segment: "inactive" },
  { id: 7, name: "Amara Bello", email: "amara@example.com", phone: "+234 810 789 0123", initials: "AB", avatarTone: "rose", channel: "Web Chat", leadStatus: "Qualified", appointmentStatus: "Booked", lastInteraction: "6 hours ago", interactionType: "Web chat", tags: ["Wellness", "Enugu"], segment: "leads" },
  { id: 8, name: "Ibrahim Musa", email: "ibrahim@example.com", phone: "+234 811 890 1234", initials: "IM", avatarTone: "slate", channel: "SMS", leadStatus: "New", appointmentStatus: "Not booked", lastInteraction: "1 day ago", interactionType: "SMS", tags: ["Product inquiry"], segment: "leads" },
  { id: 9, name: "Linda James", email: "linda@example.com", phone: "+234 812 901 2345", initials: "LJ", avatarTone: "gold", channel: "WhatsApp", leadStatus: "Qualifying", appointmentStatus: "Scheduled", lastInteraction: "1 day ago", interactionType: "AI conversation", tags: ["Branch", "Interested"], segment: "hot" },
  { id: 10, name: "Kehinde Afolabi", email: "kehinde@example.com", phone: "+234 813 012 3456", initials: "KA", avatarTone: "blue", channel: "Phone", leadStatus: "Customer", appointmentStatus: "Completed", lastInteraction: "2 days ago", interactionType: "Call ended", tags: ["VIP", "Lagos"], segment: "customers" },
];

const tabs: Array<{ id: Segment; label: string; count: string }> = [
  { id: "all", label: "All", count: "1,248" },
  { id: "leads", label: "Leads", count: "892" },
  { id: "customers", label: "Customers", count: "284" },
  { id: "hot", label: "Hot leads", count: "96" },
  { id: "inactive", label: "Inactive", count: "76" },
];

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} />, active: true },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

export default function ContactsPage() {
  const [segment, setSegment] = useState<Segment>("all");
  const [query, setQuery] = useState("");
  const [leadStatus, setLeadStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [appointmentStatus, setAppointmentStatus] = useState("all");
  const [tag, setTag] = useState("all");
  const [selected, setSelected] = useState<number[]>([]);
  const [activeContactId, setActiveContactId] = useState<number | null>(1);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return contacts.filter((contact) => {
      const matchesSegment = segment === "all" || contact.segment === segment;
      const matchesQuery = !normalized || [contact.name, contact.email, contact.phone, ...contact.tags].some((value) => value.toLowerCase().includes(normalized));
      return matchesSegment && matchesQuery && (leadStatus === "all" || contact.leadStatus === leadStatus) && (channel === "all" || contact.channel === channel) && (appointmentStatus === "all" || contact.appointmentStatus === appointmentStatus) && (tag === "all" || contact.tags.includes(tag));
    });
  }, [segment, query, leadStatus, channel, appointmentStatus, tag]);

  const activeContact = contacts.find((contact) => contact.id === activeContactId) ?? null;
  const allVisibleSelected = filtered.length > 0 && filtered.every((contact) => selected.includes(contact.id));

  const clearFilters = () => { setQuery(""); setLeadStatus("all"); setChannel("all"); setAppointmentStatus("all"); setTag("all"); };
  const toggleAll = () => allVisibleSelected
    ? setSelected((current) => current.filter((id) => !filtered.some((contact) => contact.id === id)))
    : setSelected((current) => Array.from(new Set([...current, ...filtered.map((contact) => contact.id)])));

  return (
    <main className="appShell contactsShell">
      <aside className="appSidebar contactsSidebar">
        <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
        <nav className="appNav" aria-label="Main navigation">{navItems.map((item) => <Link key={item.label} href={item.href} className={`appNavItem ${item.active ? "active" : ""}`}><span className="appNavIcon">{item.icon}</span><span>{item.label}</span>{item.badge && <b className="navBadge">{item.badge}</b>}</Link>)}</nav>
        <a className="sidebarHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace contactsWorkspace">
        <header className="contactsTopbar">
          <label className="globalSearch"><SearchIcon /><input placeholder="Search contacts, phone numbers, or tags..." /><kbd>⌘ K</kbd></label>
          <div className="contactsTopActions"><button className="agentStatus" type="button"><i />AI Agent Online <ChevronDown /></button><button className="creditPill" type="button"><MessageIcon size={15} />2,480 credits</button><button className="notificationButton" type="button">♧<i /></button><div className="profileBlock compactProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div></div>
        </header>

        <div className={`contactsContentFrame ${activeContact ? "drawerOpen" : ""}`}>
          <div className="contactsBody">
            <div className="contactsTitleRow"><h1>Contacts</h1><button className="addContactButton" type="button"><span>＋</span>Add contact<ChevronDown /></button></div>
            <div className="contactTabs">{tabs.map((tab) => <button key={tab.id} type="button" className={segment === tab.id ? "active" : ""} onClick={() => setSegment(tab.id)}>{tab.label}<span>{tab.count}</span></button>)}</div>
            <div className="contactFilters">
              <label className="contactSearch"><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contacts..." /></label>
              <select value={leadStatus} onChange={(event) => setLeadStatus(event.target.value)}><option value="all">All lead status</option>{["Hot lead", "New", "Qualified", "Nurturing", "Customer", "Lost", "Qualifying"].map((value) => <option key={value}>{value}</option>)}</select>
              <select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="all">All channels</option>{["WhatsApp", "Phone", "Web Chat", "SMS"].map((value) => <option key={value}>{value}</option>)}</select>
              <select value={appointmentStatus} onChange={(event) => setAppointmentStatus(event.target.value)}><option value="all">All appointment status</option>{["Booked", "Not booked", "Completed", "Scheduled"].map((value) => <option key={value}>{value}</option>)}</select>
              <select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">All tags</option>{Array.from(new Set(contacts.flatMap((contact) => contact.tags))).map((value) => <option key={value}>{value}</option>)}</select>
              <button type="button" className="clearFilters" onClick={clearFilters}>Clear filters</button>
            </div>

            <section className="contactsTableCard"><div className="contactsTableScroll"><table className="contactsTable">
              <thead><tr><th className="checkColumn"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} /></th><th>Name</th><th>Phone / Email</th><th>Channel</th><th>Lead status</th><th>Appointment status</th><th>Last interaction ↓</th><th>Tags</th><th className="menuColumn">⋮</th></tr></thead>
              <tbody>{filtered.map((contact) => <tr key={contact.id} className={activeContactId === contact.id ? "activeContactRow" : ""} onClick={() => setActiveContactId(contact.id)}>
                <td onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.includes(contact.id)} onChange={() => setSelected((current) => current.includes(contact.id) ? current.filter((id) => id !== contact.id) : [...current, contact.id])} /></td>
                <td><div className="contactIdentity"><span className={`contactAvatar ${contact.avatarTone}`}>{contact.initials}</span><div><strong>{contact.name}</strong><small>{contact.email}</small></div></div></td>
                <td className="contactPhone">{contact.phone}</td><td><ChannelBadge channel={contact.channel} /></td>
                <td><span className={`leadBadge ${slug(contact.leadStatus)}`}>{contact.leadStatus}{["New", "Qualified", "Qualifying"].includes(contact.leadStatus) && <ChevronDown />}</span></td>
                <td><span className={`appointmentBadge ${slug(contact.appointmentStatus)}`}>{contact.appointmentStatus}{["Booked", "Scheduled"].includes(contact.appointmentStatus) && <ChevronDown />}</span></td>
                <td><div className="interactionCell"><strong>{contact.lastInteraction}</strong><small>{contact.interactionType}</small></div></td><td><div className="tagList">{contact.tags.map((item) => <span key={item}>{item}</span>)}</div></td>
                <td onClick={(event) => event.stopPropagation()}><button className="rowMenu" type="button">•••</button></td>
              </tr>)}{filtered.length === 0 && <tr><td colSpan={9}><div className="emptyContacts">No contacts match these filters.</div></td></tr>}</tbody>
            </table></div></section>

            <footer className="contactsFooter"><span>Showing 1–{filtered.length} of 1,248 contacts</span><div className="pagination"><button type="button">‹</button><button className="active" type="button">1</button><button type="button">2</button><button type="button">3</button><button type="button">4</button><button type="button">5</button><button type="button">…</button><button type="button">125</button><button type="button">›</button></div></footer>
          </div>
          {activeContact && <ContactDrawer contact={activeContact} onClose={() => setActiveContactId(null)} />}
        </div>
      </section>
    </main>
  );
}

function ContactDrawer({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  return <aside className="contactDrawer">
    <div className="drawerHeader"><div className="drawerIdentity"><span className={`drawerAvatar contactAvatar ${contact.avatarTone}`}>{contact.initials}</span><div><div className="drawerNameRow"><h2>{contact.name}</h2><span className={`leadBadge ${slug(contact.leadStatus)}`}>{contact.leadStatus}</span></div><small><i />Last seen {contact.lastInteraction}</small></div></div><button type="button" className="drawerClose" onClick={onClose}>×</button></div>
    <div className="drawerQuickActions"><button type="button"><PhoneIcon size={15} />Call</button><button type="button" className="whatsappAction"><WhatsAppIcon />WhatsApp</button><button type="button" className="smsAction"><MessageIcon size={15} />SMS</button><button type="button">More <ChevronDown /></button></div>
    <div className="drawerTabs"><button className="active" type="button">Overview</button><button type="button">Conversations</button><button type="button">Appointments</button><button type="button">Notes</button></div>
    <div className="drawerBody">
      <section className="drawerCard"><div className="drawerCardHeading"><h3>Contact information</h3><button type="button">Edit</button></div><InfoRow icon={<PhoneIcon size={14} />} value={contact.phone} /><InfoRow icon={<MessageIcon size={14} />} value={contact.email} /><InfoRow icon={<MapPinIcon size={14} />} value="Lagos, Nigeria" /><InfoRow icon={<ClockIcon size={14} />} value="10:24 AM (WAT)" /></section>
      <section className="drawerCard"><div className="drawerCardHeading"><h3>Lead information</h3></div><div className="leadInfoGrid"><span>Lead status</span><b>{contact.leadStatus}</b><span>Source</span><b>{contact.channel}</b><span>Assigned to</span><b>AI Agent</b><span>Preferred time</span><b>Weekdays</b><span>Budget</span><b>Not specified</b></div></section>
      <section className="drawerCard aiSummaryCard"><div className="drawerCardHeading"><h3><SparkleIcon size={16} /> AI summary</h3><button type="button">Regenerate</button></div><ul><li>Interested in Juvi ginger shots.</li><li>Asked about ingredients, pricing and Lagos delivery.</li><li>Open to a consultation.</li><li>Strong conversion intent.</li></ul></section>
      <section className="drawerCard appointmentDetailCard"><div className="drawerCardHeading"><h3>Appointment</h3><button type="button">View all</button></div><div className="appointmentDetail"><span className="appointmentDetailIcon"><CalendarIcon size={18} /></span><div><strong>Consultation</strong><small>Thu, Sep 18, 2025 · 10:00 AM</small></div><span className="appointmentBadge booked">Upcoming</span></div></section>
      <section className="drawerCard activityTimelineCard"><div className="drawerCardHeading"><h3>Recent activity</h3><button type="button">View all</button></div><div className="activityTimeline"><TimelineItem tone="green" icon={<WhatsAppIcon />} title="New WhatsApp message" time="10:14 AM" detail="Interested in ginger shots." /><TimelineItem tone="blue" icon={<MessageIcon size={13} />} title="AI replied" time="10:15 AM" detail="Shared product details and pricing." /><TimelineItem tone="green" icon={<WhatsAppIcon />} title="Customer replied" time="10:20 AM" detail="Asked about delivery to Lagos." /><TimelineItem tone="orange" icon={<CalendarIcon size={13} />} title="Appointment booked" time="11:05 AM" detail="Consultation · Sep 18, 10:00 AM" /></div></section>
      <section className="drawerCard"><div className="drawerCardHeading"><h3>Tags</h3><button type="button">Manage</button></div><div className="drawerTags">{contact.tags.map((item) => <span key={item}>{item}</span>)}<button type="button">+ Add tag</button></div></section>
      <section className="drawerCard notesCard"><div className="drawerCardHeading"><h3>Notes</h3><button type="button">View all</button></div><div className="noteItem"><span>B</span><div><strong>You</strong><small>Today, 11:10 AM</small><p>Very interested. Follow up before appointment.</p></div></div><div className="noteItem"><span>AI</span><div><strong>AI Agent</strong><small>Today, 10:15 AM</small><p>Interested in wellness products and delivery.</p></div></div><button type="button" className="addNoteButton">＋ Add note</button></section>
    </div>
  </aside>;
}

function InfoRow({ icon, value }: { icon: ReactNode; value: string }) { return <div className="drawerInfoRow"><span>{icon}</span><strong>{value}</strong></div>; }
function TimelineItem({ tone, icon, title, time, detail }: { tone: string; icon: ReactNode; title: string; time: string; detail: string }) { return <div className="timelineItem"><span className={`timelineIcon ${tone}`}>{icon}</span><div><div><strong>{title}</strong><time>{time}</time></div><small>{detail}</small></div></div>; }
function ChannelBadge({ channel }: { channel: Channel }) { const icon = channel === "Phone" ? <PhoneIcon size={15} /> : channel === "WhatsApp" ? <WhatsAppIcon /> : <MessageIcon size={15} />; return <span className={`channelBadge ${slug(channel)}`}>{icon}{channel}</span>; }
function slug(value: string) { return value.toLowerCase().replace(/\s+/g, "-"); }
function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function ChevronDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>; }
function SearchIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function WhatsAppIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-11.7 7L4 20l1.5-4.1A8 8 0 1 1 20 11.5Z"/><path d="M9 8.5c.5 2.4 2 4 4.5 5l1.2-1.1 2 .8c-.2 1.7-1.1 2.7-2.7 2.8-3.8-.5-6.7-3.4-7.2-7.1.2-1.3.9-2.1 2.2-2.4Z"/></svg>; }
