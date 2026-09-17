"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CalendarIcon, DatabaseIcon, GearIcon, HelpIcon, LogoMark, MessageIcon, PhoneIcon, UsersIcon } from "@/components/icons";
import "../dashboard/dashboard.css";
import "./appointments.css";
import "./appointment-tabs.css";

type Source = "WhatsApp" | "Phone" | "Web Chat" | "SMS";
type AppointmentStatus = "Confirmed" | "Pending" | "Cancelled" | "Completed" | "No-show";
type AppointmentTab = "all" | "upcoming" | "today" | "past" | "cancelled";
type ViewMode = "calendar" | "list";

type Appointment = { id:number; date:string; dateLabel:string; time:string; endTime:string; duration:string; contact:string; initials:string; phone:string; email:string; location:string; type:string; source:Source; status:AppointmentStatus; notes:string; segment:AppointmentTab; outcome?:string; cancelledBy?:string; cancellationReason?:string };

const TODAY = "2025-09-15";
const appointments: Appointment[] = [
  {id:1,date:TODAY,dateLabel:"Sep 15, 2025",time:"9:00 AM",endTime:"9:30 AM",duration:"30 min",contact:"Chioma Okafor",initials:"CO",phone:"+234 803 123 4567",email:"chioma@example.com",location:"Lagos, Nigeria",type:"Consultation",source:"WhatsApp",status:"Confirmed",notes:"Interested in Juvi ginger shots for personal wellness.",segment:"today"},
  {id:2,date:TODAY,dateLabel:"Sep 15, 2025",time:"10:30 AM",endTime:"11:00 AM",duration:"30 min",contact:"Tunde Adebayo",initials:"TA",phone:"+234 805 234 5678",email:"tunde@example.com",location:"Abuja, Nigeria",type:"Follow-up",source:"Phone",status:"Confirmed",notes:"Pricing follow-up after inbound call.",segment:"today"},
  {id:3,date:TODAY,dateLabel:"Sep 15, 2025",time:"12:00 PM",endTime:"12:45 PM",duration:"45 min",contact:"Sarah Johnson",initials:"SJ",phone:"+234 806 345 6789",email:"sarah@example.com",location:"Lagos, Nigeria",type:"Product discussion",source:"Web Chat",status:"Pending",notes:"Asked about consultation options from web chat.",segment:"today"},
  {id:4,date:TODAY,dateLabel:"Sep 15, 2025",time:"2:00 PM",endTime:"2:30 PM",duration:"30 min",contact:"Daniel Etim",initials:"DE",phone:"+234 809 678 9012",email:"daniel@example.com",location:"Port Harcourt, Nigeria",type:"Consultation",source:"SMS",status:"Confirmed",notes:"Requested a quick consultation by SMS.",segment:"today"},
  {id:5,date:"2025-09-18",dateLabel:"Sep 18, 2025",time:"10:00 AM",endTime:"10:30 AM",duration:"30 min",contact:"Linda James",initials:"LJ",phone:"+234 812 901 2345",email:"linda@example.com",location:"Enugu, Nigeria",type:"Consultation",source:"WhatsApp",status:"Confirmed",notes:"Upcoming consultation booked by AI.",segment:"upcoming"},
  {id:6,date:"2025-09-19",dateLabel:"Sep 19, 2025",time:"1:00 PM",endTime:"1:30 PM",duration:"30 min",contact:"Kehinde Afolabi",initials:"KA",phone:"+234 813 012 3456",email:"kehinde@example.com",location:"Lagos, Nigeria",type:"Product demo",source:"Web Chat",status:"Confirmed",notes:"Product demo requested via web chat.",segment:"upcoming"},
  {id:7,date:"2025-09-10",dateLabel:"Sep 10, 2025",time:"11:00 AM",endTime:"11:30 AM",duration:"30 min",contact:"Grace Wilson",initials:"GW",phone:"+234 808 567 8901",email:"grace@example.com",location:"Lagos, Nigeria",type:"Consultation",source:"WhatsApp",status:"Completed",notes:"Completed consultation.",segment:"past",outcome:"Consultation completed"},
  {id:8,date:"2025-09-12",dateLabel:"Sep 12, 2025",time:"3:00 PM",endTime:"3:30 PM",duration:"30 min",contact:"Amara Bello",initials:"AB",phone:"+234 810 789 0123",email:"amara@example.com",location:"Enugu, Nigeria",type:"Pricing discussion",source:"SMS",status:"No-show",notes:"Customer did not join.",segment:"past",outcome:"Follow-up required"},
  {id:9,date:TODAY,dateLabel:"Sep 15, 2025",time:"5:00 PM",endTime:"5:30 PM",duration:"30 min",contact:"Ibrahim Musa",initials:"IM",phone:"+234 811 890 1234",email:"ibrahim@example.com",location:"Kano, Nigeria",type:"Follow-up",source:"Phone",status:"Cancelled",notes:"Customer requested cancellation.",segment:"cancelled",cancelledBy:"Customer",cancellationReason:"Scheduling conflict"},
  {id:10,date:"2025-09-17",dateLabel:"Sep 17, 2025",time:"4:00 PM",endTime:"4:30 PM",duration:"30 min",contact:"Emeka Onuoha",initials:"EO",phone:"+234 807 456 7890",email:"emeka@example.com",location:"Lagos, Nigeria",type:"Consultation",source:"Web Chat",status:"Cancelled",notes:"Duplicate booking.",segment:"cancelled",cancelledBy:"System",cancellationReason:"Duplicate booking"},
];

const navItems = [
  ["Dashboard","/dashboard",<HomeIcon key="h"/>],["Inbox","/inbox",<MessageIcon key="i" size={20}/>],["Contacts","/contacts",<UsersIcon key="c" size={20}/>],["Appointments","/appointments",<CalendarIcon key="a" size={20}/>],["AI Agent","/ai-agent",<BotIcon key="b"/>],["Automations","/automations",<BoltIcon key="u"/>],["Integrations","/integrations",<DatabaseIcon key="d" size={20}/>],["Settings","/settings",<GearIcon key="s" size={20}/>]
] as const;

const tabs: {id:AppointmentTab;label:string;count:number}[] = [
  {id:"all",label:"All",count:24},{id:"upcoming",label:"Upcoming",count:18},{id:"today",label:"Today",count:6},{id:"past",label:"Past",count:142},{id:"cancelled",label:"Cancelled",count:12}
];

export default function AppointmentsPage(){
  const [tab,setTab]=useState<AppointmentTab>("all");
  const [view,setView]=useState<ViewMode>("calendar");
  const [query,setQuery]=useState("");
  const [selectedId,setSelectedId]=useState<number|null>(1);
  const [statusFilter,setStatusFilter]=useState("all");
  const [sourceFilter,setSourceFilter]=useState("all");
  const [typeFilter,setTypeFilter]=useState("all");

  const effectiveView:ViewMode = (tab==="past"||tab==="cancelled") ? "list" : view;
  const filtered = useMemo(()=> appointments.filter(a=>{
    const inTab = tab==="all" || a.segment===tab;
    const q=query.toLowerCase();
    return inTab && (!q || `${a.contact} ${a.phone} ${a.type}`.toLowerCase().includes(q)) && (statusFilter==="all"||a.status===statusFilter) && (sourceFilter==="all"||a.source===sourceFilter) && (typeFilter==="all"||a.type===typeFilter);
  }),[tab,query,statusFilter,sourceFilter,typeFilter]);
  const selected=appointments.find(a=>a.id===selectedId)??null;
  const today = appointments.filter(a=>a.segment==="today");
  const upcoming = appointments.filter(a=>a.segment==="upcoming");

  function changeTab(next:AppointmentTab){ setTab(next); if(next==="past"||next==="cancelled") setView("list"); setSelectedId(null); }

  return <main className="appShell appointmentsShell">
    <aside className="appSidebar appointmentsSidebar">
      <Link className="appBrand" href="/dashboard"><LogoMark size={37}/><strong>AI Caller</strong></Link>
      <nav className="appNav">{navItems.map(([label,href,icon])=><Link key={label} href={href} className={`appNavItem ${label==="Appointments"?"active":""}`}><span className="appNavIcon">{icon}</span><span>{label}</span>{label==="Inbox"&&<b className="navBadge">3</b>}</Link>)}</nav>
      <a className="appointmentsHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18}/></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
    </aside>

    <section className="appWorkspace appointmentsWorkspace">
      <header className="appointmentsTopbar"><label className="appointmentsGlobalSearch"><SearchIcon/><input placeholder="Search appointments, contacts or phone numbers..."/><kbd>⌘ K</kbd></label><div className="appointmentsTopActions"><button className="appointmentsAgentStatus"><i/>AI Agent Online <ChevronDown/></button><button className="appointmentsCredit"><MessageIcon size={15}/>2,480 credits</button><div className="profileBlock appointmentsProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span></div></div></header>

      <div className={`appointmentsBody ${selected?"drawerOpen":""}`}>
        <div className="appointmentsTitleRow"><h1>Appointments</h1><div className="appointmentsTitleActions"><div className="viewToggle"><button className={effectiveView==="list"?"active":""} onClick={()=>setView("list")}><ListIcon/>List view</button><button disabled={tab==="past"||tab==="cancelled"} className={effectiveView==="calendar"?"active":""} onClick={()=>setView("calendar")}><CalendarIcon size={16}/>Calendar view</button></div><button className="bookAppointmentButton">＋ Book appointment</button></div></div>
        <div className="appointmentTabs">{tabs.map(t=><button key={t.id} className={tab===t.id?"active":""} onClick={()=>changeTab(t.id)}>{t.label}<span>{t.count}</span></button>)}</div>

        {tab==="today" && <TodaySummary items={today}/>}
        {tab==="cancelled" && <div className="tabNotice"><strong>Cancelled appointments</strong><span>Rebook or open the customer conversation.</span></div>}
        {tab==="past" && <div className="tabNotice"><strong>Past appointments</strong><span>Review outcomes and schedule follow-ups.</span></div>}

        {effectiveView==="calendar" ? <CalendarPanel tab={tab} today={today} upcoming={upcoming} selectedId={selectedId} onSelect={setSelectedId}/> : <CompactList items={tab==="all"?appointments:filtered} selectedId={selectedId} onSelect={setSelectedId} tab={tab}/>} 

        <section className="allAppointmentsSection"><div className="sectionHeadingInline"><h2>{tab==="upcoming"?"Upcoming appointments":tab==="today"?"Today’s appointments":tab==="past"?"Past appointments":tab==="cancelled"?"Cancelled appointments":"All appointments"}</h2></div><div className="appointmentFilters"><label className="appointmentSearch"><SearchIcon/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search appointments..."/></label><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">All statuses</option><option>Confirmed</option><option>Pending</option><option>Completed</option><option>No-show</option><option>Cancelled</option></select><select value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}><option value="all">All sources</option><option>WhatsApp</option><option>Phone</option><option>Web Chat</option><option>SMS</option></select><select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option value="all">All appointment types</option>{Array.from(new Set(appointments.map(a=>a.type))).map(v=><option key={v}>{v}</option>)}</select></div><AppointmentsTable items={filtered} tab={tab} selectedId={selectedId} onSelect={setSelectedId}/></section>
      </div>

      {selected && <AppointmentDrawer appointment={selected} tab={tab} onClose={()=>setSelectedId(null)}/>} 
    </section>
  </main>
}

function CalendarPanel({tab,today,upcoming,selectedId,onSelect}:{tab:AppointmentTab;today:Appointment[];upcoming:Appointment[];selectedId:number|null;onSelect:(id:number)=>void}){
  const items = tab==="upcoming"?upcoming:today;
  return <section className="calendarAgendaGrid"><article className="monthCalendarCard"><div className="calendarHeading"><button>‹</button><strong>September 2025</strong><button>›</button><button className="todayButton">Today</button></div><div className="weekdayRow">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><span key={d}>{d}</span>)}</div><div className="simpleMonthGrid">{Array.from({length:30},(_,i)=>i+1).map(day=><button key={day} className={day===15?"selected":""}><span>{day}</span>{[10,15,18,19,22,24,26].includes(day)&&<i/>}</button>)}</div></article><article className="dayAgendaCard"><div className="agendaHeading"><h2>{tab==="upcoming"?"Upcoming schedule":"Monday, Sep 15, 2025"}</h2><span>{items.length} appointments</span></div><div className="agendaList">{items.map(a=><button key={a.id} className={`agendaRow ${selectedId===a.id?"active":""}`} onClick={()=>onSelect(a.id)}><div className="agendaTime"><strong>{a.time}</strong><small>{a.duration}</small></div><span className={`appointmentAvatar tone${a.id%5}`}>{a.initials}</span><div className="agendaContact"><strong>{a.contact}</strong><small>{a.type}</small></div><StatusBadge status={a.status}/><SourceBadge source={a.source}/><span className="agendaChevron">›</span></button>)}</div></article></section>
}

function TodaySummary({items}:{items:Appointment[]}){const completed=items.filter(i=>i.status==="Completed").length;const cancelled=items.filter(i=>i.status==="Cancelled").length;return <div className="todaySummary"><div><strong>{items.length}</strong><span>Total today</span></div><div><strong>{Math.max(items.length-completed-cancelled,0)}</strong><span>Remaining</span></div><div><strong>{completed}</strong><span>Completed</span></div><div><strong>{cancelled}</strong><span>Cancelled</span></div></div>}

function CompactList({items,selectedId,onSelect,tab}:{items:Appointment[];selectedId:number|null;onSelect:(id:number)=>void;tab:AppointmentTab}){return <section className="appointmentListView"><div className="listViewHeading"><h2>{tab==="past"?"Past appointments":tab==="cancelled"?"Cancelled appointments":"Appointment list"}</h2><span>{items.length}</span></div><div className="upcomingCards">{items.map(a=><button key={a.id} className={`upcomingCard ${selectedId===a.id?"active":""}`} onClick={()=>onSelect(a.id)}><div><strong>{a.dateLabel}</strong><span>{a.time}</span></div><span className={`appointmentAvatar tone${a.id%5}`}>{a.initials}</span><div className="upcomingPerson"><strong>{a.contact}</strong><span>{a.type}</span></div><SourceBadge source={a.source}/><StatusBadge status={a.status}/><span className="agendaChevron">›</span></button>)}</div></section>}

function AppointmentsTable({items,tab,selectedId,onSelect}:{items:Appointment[];tab:AppointmentTab;selectedId:number|null;onSelect:(id:number)=>void}){return <div className="appointmentsTableCard"><div className="appointmentsTableScroll"><table className="appointmentsTable"><thead><tr><th>Date & time</th><th>Contact</th><th>Type</th><th>Source</th>{tab==="past"&&<th>Outcome</th>}{tab==="cancelled"&&<><th>Cancelled by</th><th>Reason</th></>}<th>Status</th><th>Actions</th></tr></thead><tbody>{items.map(a=><tr key={a.id} className={selectedId===a.id?"selectedRow":""}><td><strong>{a.dateLabel}</strong><small>{a.time}</small></td><td><button className="tableContact" onClick={()=>onSelect(a.id)}><span className={`appointmentAvatar tone${a.id%5}`}>{a.initials}</span><span><strong>{a.contact}</strong><small>{a.phone}</small></span></button></td><td>{a.type}</td><td><SourceBadge source={a.source}/></td>{tab==="past"&&<td>{a.outcome??"—"}</td>}{tab==="cancelled"&&<><td>{a.cancelledBy??"—"}</td><td>{a.cancellationReason??"—"}</td></>}<td><StatusBadge status={a.status}/></td><td><button className="openAppointment" onClick={()=>onSelect(a.id)}>{tab==="cancelled"?"Rebook":tab==="past"?"Open":"Open"}</button></td></tr>)}</tbody></table></div></div>}

function AppointmentDrawer({appointment,tab,onClose}:{appointment:Appointment;tab:AppointmentTab;onClose:()=>void}){const past=tab==="past"||appointment.segment==="past";const cancelled=tab==="cancelled"||appointment.status==="Cancelled";return <aside className="appointmentDrawer"><button className="appointmentDrawerClose" onClick={onClose}>×</button><div className="appointmentDrawerHeader"><span className={`appointmentDrawerAvatar tone${appointment.id%5}`}>{appointment.initials}</span><div><h2>{appointment.contact}</h2><StatusBadge status={appointment.status}/></div></div><div className="appointmentDetailList"><Detail icon="◫" text={appointment.type}/><Detail icon="▣" text={appointment.dateLabel}/><Detail icon="◷" text={`${appointment.time} – ${appointment.endTime} (${appointment.duration})`}/><Detail icon="⌁" text={`Booked via ${appointment.source}`}/></div>{!past&&!cancelled&&<button className="joinMeetingButton">Join meeting</button>}<div className="drawerContactCard"><span>☎</span><strong>{appointment.phone}</strong><span>✉</span><strong>{appointment.email}</strong><span>⌖</span><strong>{appointment.location}</strong></div><Link className="openConversationButton" href="/inbox"><MessageIcon size={15}/>Open conversation</Link><div className="drawerSection"><h3>Notes</h3><p>{appointment.notes}</p></div>{past&&<div className="drawerSection"><h3>Outcome</h3><p>{appointment.outcome??"No outcome recorded."}</p></div>}{cancelled&&<div className="drawerSection"><h3>Cancellation</h3><p><strong>{appointment.cancelledBy??"Customer"}</strong> · {appointment.cancellationReason??"No reason provided"}</p></div>}<div className="drawerSection appointmentActionsSection">{past?<button>Book follow-up</button>:cancelled?<button>Rebook appointment</button>:<><button><CalendarIcon size={14}/>Reschedule</button><button className="danger">Cancel appointment</button></>}<button>Add note</button></div></aside>}

function Detail({icon,text}:{icon:string;text:string}){return <div className="appointmentDetailRow"><span>{icon}</span><strong>{text}</strong></div>}
function StatusBadge({status}:{status:AppointmentStatus}){return <span className={`appointmentStatus ${status.toLowerCase().replace(/\s+/g,"-")}`}>{status}</span>}
function SourceBadge({source}:{source:Source}){const icon=source==="Phone"?<PhoneIcon size={14}/>:<MessageIcon size={14}/>;return <span className={`appointmentSource ${source.toLowerCase().replace(/\s+/g,"-")}`}>{icon}{source}</span>}
function SearchIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>}
function ChevronDown(){return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>}
function ListIcon(){return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>}
function HomeIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>}
function BotIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>}
function BoltIcon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>}
