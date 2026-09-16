import Link from "next/link";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  DatabaseIcon,
  GearIcon,
  LogoMark,
  MessageIcon,
  PhoneIcon,
  RocketIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/icons";
import "./dashboard.css";

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon />, active: true },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

const metrics = [
  { label: "New inquiries", value: "48", change: "↑ 12%", tone: "blue", icon: <MessageIcon size={20} />, spark: "6,26 20,29 34,24 48,20 62,20 76,14 90,11 104,16 118,18 132,12 146,5" },
  { label: "AI conversations", value: "320", change: "↑ 28%", tone: "purple", icon: <PhoneIcon size={20} />, spark: "6,28 20,25 34,30 48,29 62,21 76,16 90,12 104,14 118,20 132,18 146,8" },
  { label: "Qualified leads", value: "56", change: "↑ 18%", tone: "green", icon: <UsersIcon size={20} />, spark: "6,27 20,25 34,30 48,29 62,23 76,21 90,14 104,12 118,17 132,16 146,7" },
  { label: "Appointments", value: "24", change: "↑ 20%", tone: "orange", icon: <CalendarIcon size={20} />, spark: "6,27 20,24 34,29 48,31 62,25 76,18 90,16 104,12 118,16 132,16 146,7" },
  { label: "Human takeovers", value: "6", change: "↓ 14%", tone: "red", icon: <UsersIcon size={20} />, spark: "6,20 20,18 34,24 48,26 62,19 76,14 90,18 104,16 118,14 132,26 146,22" },
];

const activities = [
  { tone: "blue", icon: <PhoneIcon size={16} />, label: "New inquiry from +234 803 123 4567", time: "2 min ago", tag: "AI handled" },
  { tone: "green", icon: <CalendarIcon size={16} />, label: "Appointment booked by Sarah U.", time: "12 min ago", tag: "Consultation" },
  { tone: "blue", icon: <MessageIcon size={16} />, label: "New WhatsApp message", time: "25 min ago", tag: "AI handled" },
  { tone: "orange", icon: <UsersIcon size={16} />, label: "Lead qualified: Michael T.", time: "1 hour ago", tag: "Interested" },
  { tone: "blue", icon: <UsersIcon size={16} />, label: "Human takeover — pricing question", time: "2 hours ago", tag: "Transferred" },
];

export default function DashboardPage() {
  return (
    <main className="appShell">
      <aside className="appSidebar">
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

      <section className="appWorkspace">
        <header className="appTopbar">
          <h1>Dashboard</h1>
          <div className="topbarActions">
            <button className="dateRange" type="button"><CalendarIcon size={17} /><span>Sep 1, 2025 – Sep 15, 2025</span><ChevronDown /></button>
            <div className="profileBlock">
              <span className="avatar">B</span>
              <span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span>
              <ChevronDown />
            </div>
          </div>
        </header>

        <div className="dashboardBody">
          <section className="metricsGrid">
            {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
            <article className="metricCard creditMetric">
              <span className="metricIcon purple"><DatabaseIcon size={20} /></span>
              <strong className="metricValue">2,480</strong>
              <span className="metricLabel">Credit balance</span>
              <button type="button" className="topupOutline">Top up</button>
            </article>
          </section>

          <section className="analyticsGrid">
            <article className="dashboardCard conversationsCard">
              <div className="cardHeading">
                <h2>Inquiries &amp; Conversations</h2>
                <div className="chartLegend"><span><i className="blueDot" />New inquiries</span><span><i className="purpleDot" />AI conversations</span><button type="button">Last 14 days <ChevronDown /></button></div>
              </div>
              <div className="lineChart">
                <div className="yLabels"><span>80</span><span>60</span><span>40</span><span>20</span><span>0</span></div>
                <div className="chartCanvas">
                  <div className="gridLines">{Array.from({ length: 5 }).map((_, i) => <i key={i} />)}</div>
                  <svg viewBox="0 0 720 180" preserveAspectRatio="none" aria-hidden="true">
                    <polyline className="chartLine inquiries" points="0,145 55,145 110,145 165,125 220,137 275,145 330,136 385,118 440,127 495,140 550,124 605,132 660,126 720,115" />
                    <polyline className="chartLine conversations" points="0,95 55,94 110,92 165,70 220,76 275,94 330,91 385,68 440,75 495,92 550,69 605,77 660,72 720,60" />
                  </svg>
                  <div className="xLabels"><span>Sep 1</span><span>Sep 3</span><span>Sep 5</span><span>Sep 7</span><span>Sep 9</span><span>Sep 11</span><span>Sep 13</span><span>Sep 15</span></div>
                </div>
              </div>
            </article>

            <article className="dashboardCard appointmentsCard">
              <div className="cardHeading"><h2>Appointments</h2><a href="/appointments">View all</a></div>
              <div className="appointmentSummary"><strong>24</strong><span>↑ 20%</span></div>
              <div className="appointmentLegend"><span><i className="blueDot" />Scheduled <b>18</b></span><span><i className="greenDot" />Completed <b>4</b></span><span><i className="redDot" />Cancelled <b>2</b></span></div>
              <div className="barChart" aria-label="Appointments by day">
                {[6,9,4,6,8,10,5,8,7,8,9,12,11,12,10].map((value, i) => <span key={i} style={{ height: `${value * 7}px` }}><i /><em /></span>)}
              </div>
              <div className="barLabels"><span>Sep 1</span><span>Sep 3</span><span>Sep 5</span><span>Sep 7</span><span>Sep 9</span><span>Sep 11</span><span>Sep 13</span><span>Sep 15</span></div>
            </article>
          </section>

          <section className="bottomGrid">
            <article className="dashboardCard activityCard">
              <div className="cardHeading"><h2>Recent activity</h2><a href="/inbox">View all</a></div>
              <div className="activityList">
                {activities.map((item) => <div className="activityRow" key={item.label}><span className={`activityIcon ${item.tone}`}>{item.icon}</span><strong>{item.label}</strong><time>{item.time}</time><span className="activityTag">{item.tag}</span></div>)}
              </div>
            </article>

            <article className="dashboardCard attentionCard">
              <div className="cardHeading"><h2>Needs attention <span className="attentionBadge">3</span></h2><a href="/inbox">View all</a></div>
              <div className="attentionList">
                <AttentionRow tone="red" icon={<AlertIcon />} title="3 unanswered inquiries" subtitle="> 30 minutes" />
                <AttentionRow tone="orange" icon={<CalendarIcon size={17} />} title="2 appointments need confirmation" subtitle="Today" />
                <AttentionRow tone="blue" icon={<MessageIcon size={17} />} title="1 lead waiting for follow-up" subtitle="High intent" />
              </div>
            </article>

            <article className="dashboardCard creditCard">
              <div className="cardHeading"><h2>Credit balance</h2><a href="/settings">View details</a></div>
              <div className="creditContent">
                <div className="creditDonut"><div><strong>2,480</strong><span>credits left</span></div></div>
                <div className="creditLegend"><span><i className="usedDot" />Used <b>520</b></span><span><i className="remainingDot" />Remaining <b>2,480</b></span></div>
              </div>
              <button type="button" className="topupButton">Top up credits</button>
            </article>
          </section>
        </div>
      </section>
    </main>
  );
}

function MetricCard({ label, value, change, tone, icon, spark }: { label: string; value: string; change: string; tone: string; icon: ReactNode; spark: string }) {
  return <article className="metricCard"><span className={`metricIcon ${tone}`}>{icon}</span><strong className="metricValue">{value}</strong><span className="metricLabel">{label}</span><span className={`metricChange ${tone === "red" ? "down" : ""}`}>{change}</span><svg className={`sparkline ${tone}`} viewBox="0 0 152 34" preserveAspectRatio="none" aria-hidden="true"><polyline points={spark} /></svg></article>;
}

function AttentionRow({ tone, icon, title, subtitle }: { tone: string; icon: ReactNode; title: string; subtitle: string }) {
  return <div className="attentionRow"><span className={`attentionIcon ${tone}`}>{icon}</span><div><strong>{title}</strong><small>{subtitle}</small></div><span className="attentionChevron">›</span></div>;
}

function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function ChevronDown() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>; }
function AlertIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>; }
