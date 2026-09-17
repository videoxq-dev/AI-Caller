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
import "./appointments.css";

type Source = "WhatsApp" | "Phone" | "Web Chat" | "SMS";
type AppointmentStatus = "Confirmed" | "Pending" | "Cancelled" | "Completed";
type AppointmentTab = "all" | "upcoming" | "today" | "past" | "cancelled";
type ViewMode = "calendar" | "list";

type Appointment = {
  id: number;
  date: string;
  dateLabel: string;
  time: string;
  endTime: string;
  duration: string;
  contact: string;
  initials: string;
  phone: string;
  email: string;
  location: string;
  type: string;
  source: Source;
  status: AppointmentStatus;
  notes: string;
  segment: Exclude<AppointmentTab, "all"> | "upcoming";
};

const appointments: Appointment[] = [
  { id: 1, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "9:00 AM", endTime: "9:30 AM", duration: "30 min", contact: "Chioma Okafor", initials: "CO", phone: "+234 803 123 4567", email: "chioma@example.com", location: "Lagos, Nigeria", type: "Consultation", source: "WhatsApp", status: "Confirmed", notes: "Interested in Juvi ginger shots for personal wellness. Wants to discuss bulk pricing.", segment: "today" },
  { id: 2, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "10:30 AM", endTime: "11:00 AM", duration: "30 min", contact: "Tunde Adebayo", initials: "TA", phone: "+234 805 234 5678", email: "tunde@example.com", location: "Abuja, Nigeria", type: "Follow-up", source: "Phone", status: "Confirmed", notes: "Pricing follow-up after inbound call.", segment: "today" },
  { id: 3, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "12:00 PM", endTime: "12:45 PM", duration: "45 min", contact: "Sarah Johnson", initials: "SJ", phone: "+234 806 345 6789", email: "sarah@example.com", location: "Lagos, Nigeria", type: "Product discussion", source: "Web Chat", status: "Pending", notes: "Asked about consultation options from web chat.", segment: "today" },
  { id: 4, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "2:00 PM", endTime: "2:30 PM", duration: "30 min", contact: "Daniel Etim", initials: "DE", phone: "+234 809 678 9012", email: "daniel@example.com", location: "Port Harcourt, Nigeria", type: "Consultation", source: "SMS", status: "Confirmed", notes: "Requested a quick consultation by SMS.", segment: "today" },
  { id: 5, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "3:30 PM", endTime: "4:00 PM", duration: "30 min", contact: "Amara Bello", initials: "AB", phone: "+234 810 789 0123", email: "amara@example.com", location: "Enugu, Nigeria", type: "Pricing discussion", source: "WhatsApp", status: "Confirmed", notes: "High-intent pricing conversation.", segment: "today" },
  { id: 6, date: "2025-09-15", dateLabel: "Sep 15, 2025", time: "5:00 PM", endTime: "5:30 PM", duration: "30 min", contact: "Ibrahim Musa", initials: "IM", phone: "+234 811 890 1234", email: "ibrahim@example.com", location: "Kano, Nigeria", type: "Follow-up", source: "Phone", status: "Cancelled", notes: "Customer requested cancellation.", segment: "cancelled" },
  { id: 7, date: "2025-09-18", dateLabel: "Sep 18, 2025", time: "10:00 AM", endTime: "10:30 AM", duration: "30 min", contact: "Linda James", initials: "LJ", phone: "+234 812 901 2345", email: "linda@example.com", location: "Enugu, Nigeria", type: "Consultation", source: "WhatsApp", status: "Confirmed", notes: "Upcoming consultation booked by AI.", segment: "upcoming" },
  { id: 8, date: "2025-09-19", dateLabel: "Sep 19, 2025", time: "1:00 PM", endTime: "1:30 PM", duration: "30 min", contact: "Kehinde Afolabi", initials: "KA", phone: "+234 813 012 3456", email: "kehinde@example.com", location: "Lagos, Nigeria", type: "Product demo", source: "Web Chat", status: "Confirmed", notes: "Product demo requested via web chat.", segment: "upcoming" },
  { id: 9, date: "2025-09-10", dateLabel: "Sep 10, 2025", time: "11:00 AM", endTime: "11:30 AM", duration: "30 min", contact: "Grace Wilson", initials: "GW", phone: "+234 808 567 8901", email: "grace@example.com", location: "Lagos, Nigeria", type: "Consultation", source: "WhatsApp", status: "Completed", notes: "Completed consultation.", segment: "past" },
];

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} />, active: true },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

const tabCounts: Array<{ id: AppointmentTab; label: string; count: number }> = [
  { id: "all", label: "All", count: 24 },
  { id: "upcoming", label: "Upcoming", count: 18 },
  { id: "today", label: "Today", count: 6 },
  { id: "past", label: "Past", count: 142 },
  { id: "cancelled", label: "Cancelled", count: 12 },
];

const calendarDays = [
  { n: "31", muted: true }, { n: "1" }, { n: "2", dot: "blue" }, { n: "3", dot: "purple" }, { n: "4" }, { n: "5" }, { n: "6" },
  { n: "7" }, { n: "8", dot: "green" }, { n: "9" }, { n: "10", dot: "green" }, { n: "11", dot: "blue" }, { n: "12" }, { n: "13", dot: "purple" },
  { n: "14" }, { n: "15", selected: true }, { n: "16", dot: "teal" }, { n: "17", dots: true }, { n: "18", dot: "teal" }, { n: "19", dot: "green" }, { n: "20" },
  { n: "21" }, { n: "22", dot: "blue" }, { n: "23" }, { n: "24", dot: "green" }, { n: "25" }, { n: "26", dot: "purple" }, { n: "27" },
  { n: "28" }, { n: "29" }, { n: "30" }, { n: "1", muted: true }, { n: "2", muted: true }, { n: "3", muted: true }, { n: "4", muted: true },
];

export default function AppointmentsPage() {
  const [view, setView] = useState<ViewMode>("calendar");
  const [tab, setTab] = useState<AppointmentTab>("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(1);
  const [statusOverrides, setStatusOverrides] = useState<Record<number, AppointmentStatus>>({});
  const [rescheduleMode, setRescheduleMode] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return appointments.filter((appointment) => {
      const effectiveStatus = statusOverrides[appointment.id] ?? appointment.status;
      const matchesTab = tab === "all" || appointment.segment === tab || (tab === "cancelled" && effectiveStatus === "Cancelled");
      const matchesQuery = !normalized || [appointment.contact, appointment.phone, appointment.type].some((value) => value.toLowerCase().includes(normalized));
      const matchesStatus = statusFilter === "all" || effectiveStatus === statusFilter;
      const matchesSource = sourceFilter === "all" || appointment.source === sourceFilter;
      const matchesType = typeFilter === "all" || appointment.type === typeFilter;
      return matchesTab && matchesQuery && matchesStatus && matchesSource && matchesType;
    });
  }, [query, statusFilter, sourceFilter, typeFilter, tab, statusOverrides]);

  const selected = appointments.find((appointment) => appointment.id === selectedId) ?? null;
  const selectedStatus = selected ? (statusOverrides[selected.id] ?? selected.status) : null;
  const todayAppointments = appointments.filter((appointment) => appointment.date === "2025-09-15");
  const upcomingAppointments = appointments.filter((appointment) => appointment.segment === "upcoming" || appointment.segment === "today");

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setSourceFilter("all");
    setTypeFilter("all");
  };

  return (
    <main className="appShell appointmentsShell">
      <aside className="appSidebar appointmentsSidebar">
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
        <a className="appointmentsHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace appointmentsWorkspace">
        <header className="appointmentsTopbar">
          <label className="appointmentsGlobalSearch"><SearchIcon /><input placeholder="Search appointments, contacts or phone numbers..." /><kbd>⌘ K</kbd></label>
          <div className="appointmentsTopActions">
            <button className="appointmentsAgentStatus" type="button"><i />AI Agent Online <ChevronDown /></button>
            <button className="appointmentsCredit" type="button"><MessageIcon size={15} />2,480 credits</button>
            <button className="appointmentsBell" type="button" aria-label="Notifications">♧<i /></button>
            <div className="profileBlock appointmentsProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className={`appointmentsBody ${selected ? "drawerOpen" : ""}`}>
          <div className="appointmentsTitleRow">
            <h1>Appointments</h1>
            <div className="appointmentsTitleActions">
              <div className="viewToggle">
                <button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")}><ListIcon />List view</button>
                <button type="button" className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}><CalendarIcon size={16} />Calendar view</button>
              </div>
              <button type="button" className="bookAppointmentButton">＋ Book appointment <ChevronDown /></button>
            </div>
          </div>

          <div className="appointmentTabs" role="tablist" aria-label="Appointment groups">
            {tabCounts.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}<span>{item.count}</span></button>)}
          </div>

          {view === "calendar" ? (
            <section className="calendarAgendaGrid">
              <article className="monthCalendarCard">
                <div className="calendarHeading"><button type="button">‹</button><strong>September 2025</strong><button type="button">›</button><button type="button" className="todayButton">Today</button></div>
                <div className="weekdayRow">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day) => <span key={day}>{day}</span>)}</div>
                <div className="monthGrid">
                  {calendarDays.map((day, index) => <button key={`${day.n}-${index}`} type="button" className={`${day.selected ? "selected" : ""} ${day.muted ? "muted" : ""}`}><span>{day.n}</span>{day.dot && <i className={day.dot} />}{day.dots && <em><i className="blue" /><i className="green" /><i className="purple" /></em>}</button>)}
                </div>
              </article>

              <article className="dayAgendaCard">
                <div className="agendaHeading"><h2>Monday, Sep 15, 2025</h2><span>6 appointments</span></div>
                <div className="agendaList">
                  {todayAppointments.map((appointment) => <button type="button" key={appointment.id} className={`agendaRow ${selectedId === appointment.id ? "active" : ""}`} onClick={() => { setSelectedId(appointment.id); setRescheduleMode(false); }}><div className="agendaTime"><strong>{appointment.time}</strong><small>{appointment.duration}</small></div><span className={`appointmentAvatar tone${appointment.id % 5}`}>{appointment.initials}</span><div className="agendaContact"><strong>{appointment.contact}</strong><small>{appointment.type}</small></div><StatusBadge status={statusOverrides[appointment.id] ?? appointment.status} /><SourceBadge source={appointment.source} /><span className="agendaChevron">›</span></button>)}
                </div>
              </article>
            </section>
          ) : (
            <section className="appointmentListView">
              <div className="listViewHeading"><h2>Upcoming appointments</h2><span>{upcomingAppointments.length} scheduled</span></div>
              <div className="upcomingCards">
                {upcomingAppointments.map((appointment) => <button type="button" className={`upcomingCard ${selectedId === appointment.id ? "active" : ""}`} key={appointment.id} onClick={() => { setSelectedId(appointment.id); setRescheduleMode(false); }}><div><strong>{appointment.dateLabel}</strong><span>{appointment.time} · {appointment.duration}</span></div><span className={`appointmentAvatar tone${appointment.id % 5}`}>{appointment.initials}</span><div className="upcomingPerson"><strong>{appointment.contact}</strong><span>{appointment.type}</span></div><SourceBadge source={appointment.source} /><StatusBadge status={statusOverrides[appointment.id] ?? appointment.status} /><span>›</span></button>)}
              </div>
            </section>
          )}

          <section className="allAppointmentsSection">
            <h2>All appointments</h2>
            <div className="appointmentFilters">
              <label className="appointmentSearch"><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search appointments..." /></label>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{["Confirmed","Pending","Cancelled","Completed"].map((value) => <option key={value}>{value}</option>)}</select>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All sources</option>{["WhatsApp","Phone","Web Chat","SMS"].map((value) => <option key={value}>{value}</option>)}</select>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All appointment types</option>{Array.from(new Set(appointments.map((item) => item.type))).map((value) => <option key={value}>{value}</option>)}</select>
              <button type="button" className="appointmentsClearFilters" onClick={clearFilters}>Clear filters</button>
            </div>

            <div className="appointmentsTableCard">
              <div className="appointmentsTableScroll">
                <table className="appointmentsTable">
                  <thead><tr><th><input type="checkbox" aria-label="Select all appointments" /></th><th>Date &amp; time</th><th>Contact</th><th>Type</th><th>Source</th><th>Status</th><th>Actions</th><th /></tr></thead>
                  <tbody>
                    {filtered.map((appointment) => <tr key={appointment.id} className={selectedId === appointment.id ? "selectedRow" : ""}><td><input type="checkbox" aria-label={`Select ${appointment.contact}`} /></td><td><strong>{appointment.dateLabel}</strong><small>{appointment.time}</small></td><td><button type="button" className="tableContact" onClick={() => { setSelectedId(appointment.id); setRescheduleMode(false); }}><span className={`appointmentAvatar tone${appointment.id % 5}`}>{appointment.initials}</span><div><strong>{appointment.contact}</strong><small>{appointment.phone}</small></div></button></td><td>{appointment.type}</td><td><SourceBadge source={appointment.source} /></td><td><StatusBadge status={statusOverrides[appointment.id] ?? appointment.status} /></td><td><button type="button" className="openAppointment" onClick={() => { setSelectedId(appointment.id); setRescheduleMode(false); }}>Open</button></td><td><button type="button" className="appointmentMenu">•••</button></td></tr>)}
                    {filtered.length === 0 && <tr><td colSpan={8}><div className="emptyAppointments">No appointments match these filters.</div></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </section>

      {selected && (
        <aside className="appointmentDrawer" aria-label={`${selected.contact} appointment details`}>
          <button type="button" className="appointmentDrawerClose" onClick={() => setSelectedId(null)} aria-label="Close appointment details">×</button>
          <div className="appointmentDrawerHeader">
            <span className={`appointmentDrawerAvatar tone${selected.id % 5}`}>{selected.initials}</span>
            <div><h2>{selected.contact}</h2>{selectedStatus && <StatusBadge status={selectedStatus} />}</div>
          </div>

          <div className="appointmentDetailList">
            <DetailRow icon={<CalendarIcon size={16} />}><strong>{selected.type}</strong></DetailRow>
            <DetailRow icon={<CalendarIcon size={16} />}><strong>Mon, {selected.dateLabel}</strong></DetailRow>
            <DetailRow icon={<ClockIcon />}><strong>{selected.time} – {selected.endTime} ({selected.duration})</strong></DetailRow>
            <DetailRow icon={<VideoIcon />}><strong>Zoom (Online)</strong></DetailRow>
            <DetailRow icon={<SourceIcon source={selected.source} />}><span>Booked via {selected.source}</span></DetailRow>
          </div>

          <button type="button" className="joinMeetingButton">Join meeting <ChevronDown /></button>

          <section className="drawerContactCard">
            <span>☎</span><strong>{selected.phone}</strong>
            <span>✉</span><strong>{selected.email}</strong>
            <span>⌖</span><strong>{selected.location}</strong>
          </section>

          <Link className="openConversationButton" href="/inbox"><MessageIcon size={16} />Open conversation</Link>

          <section className="drawerSection"><div className="drawerSectionHeading"><h3>Notes</h3></div><p>{selected.notes}</p></section>

          {rescheduleMode && <section className="reschedulePanel"><strong>Reschedule</strong><div><input type="date" defaultValue={selected.date} /><input type="time" defaultValue="09:00" /></div><button type="button" onClick={() => setRescheduleMode(false)}>Save new time</button></section>}

          <section className="drawerSection appointmentActionsSection"><h3>Appointment actions</h3><button type="button" onClick={() => setRescheduleMode((value) => !value)}><CalendarIcon size={15} />Reschedule</button><button type="button" className="danger" onClick={() => { setStatusOverrides((current) => ({ ...current, [selected.id]: "Cancelled" })); setRescheduleMode(false); }}>⌫ Cancel appointment</button><button type="button">▣ Add note</button></section>
        </aside>
      )}
    </main>
  );
}

function SourceBadge({ source }: { source: Source }) {
  const icon = source === "Phone" ? <PhoneIcon size={14} /> : source === "WhatsApp" ? <WhatsAppIcon /> : <MessageIcon size={14} />;
  return <span className={`appointmentSource ${slug(source)}`}>{icon}{source}</span>;
}

function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <span className={`appointmentStatus ${slug(status)}`}>{status}</span>;
}

function DetailRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="appointmentDetailRow"><span>{icon}</span><div>{children}</div></div>;
}

function SourceIcon({ source }: { source: Source }) {
  if (source === "Phone") return <PhoneIcon size={15} />;
  if (source === "WhatsApp") return <WhatsAppIcon />;
  return <MessageIcon size={15} />;
}

function slug(value: string) { return value.toLowerCase().replace(/\s+/g, "-"); }
function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function SearchIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function ChevronDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>; }
function ListIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>; }
function WhatsAppIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-11.9 7l-4.1 1.1 1.1-4A8 8 0 1 1 20 11.5Z"/><path d="M9 8.5c.5 2 2 3.5 4 4l1-1.1 2 .5c.2.1.3.3.2.5-.4 1.1-1.3 1.8-2.6 1.7-3.6-.3-6.3-3-6.6-6.6-.1-1.3.6-2.2 1.7-2.6.2-.1.4 0 .5.2l.5 2Z"/></svg>; }
function ClockIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>; }
function VideoIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 5-3v10l-5-3"/></svg>; }
