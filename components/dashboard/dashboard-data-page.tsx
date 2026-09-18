"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  CalendarIcon,
  DatabaseIcon,
  MessageIcon,
  PhoneIcon,
  UsersIcon,
} from "@/components/icons";
import { AppNav } from "@/components/core-domain/app-nav";

type DashboardMetric = {
  value: number;
  previousValue: number;
  changePercent: number | null;
};

type DashboardSeriesPoint = {
  day: string;
  inquiries: number;
  aiConversations: number;
  qualifiedLeads: number;
  appointments: number;
  scheduledAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  humanTakeovers: number;
};

type DashboardActivity = {
  id: string;
  kind: "INQUIRY" | "VOICE_CALL" | "LEAD_QUALIFIED" | "APPOINTMENT" | "HUMAN_TAKEOVER";
  label: string;
  detail: string;
  occurredAt: string;
  href: string;
};

type DashboardData = {
  range: { days: 7 | 30 | 90; start: string; end: string };
  metrics: {
    inquiries: DashboardMetric;
    aiConversations: DashboardMetric;
    qualifiedLeads: DashboardMetric;
    appointments: DashboardMetric;
    humanTakeovers: DashboardMetric;
  };
  credit: { balance: number; usedInPeriod: number };
  appointmentStatus: { scheduled: number; completed: number; cancelled: number };
  series: DashboardSeriesPoint[];
  activity: DashboardActivity[];
  attention: {
    unansweredInquiries: number;
    pendingAppointments: number;
    qualifiedFollowups: number;
  };
};

const emptyMetric: DashboardMetric = { value: 0, previousValue: 0, changePercent: 0 };
const emptyData: DashboardData = {
  range: { days: 30, start: new Date(0).toISOString(), end: new Date(0).toISOString() },
  metrics: {
    inquiries: emptyMetric,
    aiConversations: emptyMetric,
    qualifiedLeads: emptyMetric,
    appointments: emptyMetric,
    humanTakeovers: emptyMetric,
  },
  credit: { balance: 0, usedInPeriod: 0 },
  appointmentStatus: { scheduled: 0, completed: 0, cancelled: 0 },
  series: [],
  activity: [],
  attention: { unansweredInquiries: 0, pendingAppointments: 0, qualifiedFollowups: 0 },
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

function formatDateRange(start: string, end: string) {
  if (start === new Date(0).toISOString()) return "Loading range…";
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
}

function formatRelative(value: string) {
  const deltaSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
  const minutes = Math.round(deltaSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function trendLabel(metric: DashboardMetric) {
  if (metric.changePercent === null) return "New vs prior period";
  if (metric.changePercent === 0) return "No change";
  return `${metric.changePercent > 0 ? "↑" : "↓"} ${Math.abs(metric.changePercent)}%`;
}

function points(values: number[], width = 720, height = 180, maxValue?: number) {
  if (!values.length) return "";
  const max = Math.max(maxValue ?? Math.max(...values, 1), 1);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 12 - (value / max) * (height - 28);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function sparkPoints(values: number[]) {
  return points(values, 152, 34);
}

function bucketSeries(series: DashboardSeriesPoint[], maxBuckets = 15) {
  if (series.length <= maxBuckets) return series;
  const size = Math.ceil(series.length / maxBuckets);
  const result: DashboardSeriesPoint[] = [];
  for (let index = 0; index < series.length; index += size) {
    const slice = series.slice(index, index + size);
    const last = slice[slice.length - 1];
    result.push({
      day: last.day,
      inquiries: slice.reduce((sum, item) => sum + item.inquiries, 0),
      aiConversations: slice.reduce((sum, item) => sum + item.aiConversations, 0),
      qualifiedLeads: slice.reduce((sum, item) => sum + item.qualifiedLeads, 0),
      appointments: slice.reduce((sum, item) => sum + item.appointments, 0),
      scheduledAppointments: slice.reduce((sum, item) => sum + item.scheduledAppointments, 0),
      completedAppointments: slice.reduce((sum, item) => sum + item.completedAppointments, 0),
      cancelledAppointments: slice.reduce((sum, item) => sum + item.cancelledAppointments, 0),
      humanTakeovers: slice.reduce((sum, item) => sum + item.humanTakeovers, 0),
    });
  }
  return result;
}

function activityTone(kind: DashboardActivity["kind"]) {
  if (kind === "APPOINTMENT") return "green";
  if (kind === "LEAD_QUALIFIED") return "orange";
  if (kind === "HUMAN_TAKEOVER") return "blue";
  return "blue";
}

function activityIcon(kind: DashboardActivity["kind"]) {
  if (kind === "APPOINTMENT") return <CalendarIcon size={16} />;
  if (kind === "LEAD_QUALIFIED" || kind === "HUMAN_TAKEOVER") return <UsersIcon size={16} />;
  if (kind === "VOICE_CALL") return <PhoneIcon size={16} />;
  return <MessageIcon size={16} />;
}

export function DashboardDataPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/dashboard?days=${days}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as DashboardData | { error?: { message?: string } } | null;
        if (!response.ok) {
          const message = payload && "error" in payload ? payload.error?.message : null;
          throw new Error(message || "Unable to load dashboard.");
        }
        return payload as DashboardData;
      })
      .then((payload) => setData(payload))
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Unable to load dashboard.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, refreshKey]);

  const chartSeries = useMemo(() => bucketSeries(data.series), [data.series]);
  const chartMax = Math.max(
    4,
    ...chartSeries.map((item) => Math.max(item.inquiries, item.aiConversations)),
  );
  const yLabels = [chartMax, Math.round(chartMax * 0.75), Math.round(chartMax * 0.5), Math.round(chartMax * 0.25), 0];
  const appointmentMax = Math.max(1, ...chartSeries.map((item) => item.appointments));
  const hasConversationActivity = data.metrics.inquiries.value > 0 || data.metrics.aiConversations.value > 0;
  const hasAppointmentActivity = data.metrics.appointments.value > 0;
  const creditTotal = data.credit.balance + data.credit.usedInPeriod;
  const remainingPercent = creditTotal > 0 ? Math.round((data.credit.balance / creditTotal) * 100) : 0;
  const attentionTotal = data.attention.unansweredInquiries + data.attention.pendingAppointments + data.attention.qualifiedFollowups;

  const metrics = [
    {
      label: "New inquiries",
      metric: data.metrics.inquiries,
      tone: "blue",
      icon: <MessageIcon size={20} />,
      values: data.series.map((item) => item.inquiries),
    },
    {
      label: "AI conversations",
      metric: data.metrics.aiConversations,
      tone: "purple",
      icon: <PhoneIcon size={20} />,
      values: data.series.map((item) => item.aiConversations),
    },
    {
      label: "Qualified leads",
      metric: data.metrics.qualifiedLeads,
      tone: "green",
      icon: <UsersIcon size={20} />,
      values: data.series.map((item) => item.qualifiedLeads),
    },
    {
      label: "Appointments",
      metric: data.metrics.appointments,
      tone: "orange",
      icon: <CalendarIcon size={20} />,
      values: data.series.map((item) => item.appointments),
    },
    {
      label: "Human takeovers",
      metric: data.metrics.humanTakeovers,
      tone: "red",
      icon: <UsersIcon size={20} />,
      values: data.series.map((item) => item.humanTakeovers),
    },
  ];

  return (
    <main className="appShell">
      <AppNav active="Dashboard" />
      <section className="appWorkspace">
        <header className="appTopbar">
          <div>
            <h1>Dashboard</h1>
            <span className="dashboardLiveLabel">{loading ? "Refreshing workspace data…" : "Live workspace data"}</span>
          </div>
          <div className="topbarActions">
            <label className="dateRange dashboardRangeSelect">
              <CalendarIcon size={17} />
              <select aria-label="Dashboard date range" value={days} onChange={(event) => setDays(Number(event.target.value) as 7 | 30 | 90)}>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </label>
            <button className="dashboardRefreshButton" type="button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <div className="dashboardBody">
          <div className="dashboardRangeSummary">{formatDateRange(data.range.start, data.range.end)}</div>
          {error && <div className="dashboardError" role="alert"><strong>Dashboard unavailable</strong><span>{error}</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Try again</button></div>}

          <section className="metricsGrid" aria-busy={loading}>
            {metrics.map((item) => (
              <MetricCard
                key={item.label}
                label={item.label}
                metric={item.metric}
                tone={item.tone}
                icon={item.icon}
                values={item.values}
              />
            ))}
            <article className="metricCard creditMetric">
              <span className="metricIcon purple"><DatabaseIcon size={20} /></span>
              <strong className="metricValue">{formatNumber(data.credit.balance)}</strong>
              <span className="metricLabel">Credit balance</span>
              <span className="metricChange">{formatNumber(data.credit.usedInPeriod)} used in period</span>
              <Link className="topupOutline dashboardButtonLink" href="/settings/billing">Top up / usage</Link>
            </article>
          </section>

          <section className="analyticsGrid">
            <article className="dashboardCard conversationsCard">
              <div className="cardHeading">
                <div><h2>Inquiries &amp; Conversations</h2><p className="cardSubcopy">Workspace activity for the selected period</p></div>
                <div className="chartLegend"><span><i className="blueDot" />New inquiries</span><span><i className="purpleDot" />AI conversations</span></div>
              </div>
              {hasConversationActivity ? (
                <div className="lineChart">
                  <div className="yLabels">{yLabels.map((value, index) => <span key={index}>{value}</span>)}</div>
                  <div className="chartCanvas">
                    <div className="gridLines">{Array.from({ length: 5 }).map((_, index) => <i key={index} />)}</div>
                    <svg viewBox="0 0 720 180" preserveAspectRatio="none" aria-label="Inquiries and AI conversations over time">
                      <polyline className="chartLine inquiries" points={points(chartSeries.map((item) => item.inquiries), 720, 180, chartMax)} />
                      <polyline className="chartLine conversations" points={points(chartSeries.map((item) => item.aiConversations), 720, 180, chartMax)} />
                    </svg>
                    <div className="xLabels">{chartSeries.map((item, index) => {
                      const show = index === 0 || index === chartSeries.length - 1 || index % Math.max(1, Math.ceil(chartSeries.length / 6)) === 0;
                      return show ? <span key={item.day}>{formatShortDate(item.day)}</span> : <span key={item.day} aria-hidden />;
                    })}</div>
                  </div>
                </div>
              ) : <EmptyCard text="No conversation activity in this period." />}
            </article>

            <article className="dashboardCard appointmentsCard">
              <div className="cardHeading"><h2>Appointments</h2><Link href="/appointments">View all</Link></div>
              <div className="appointmentSummary"><strong>{formatNumber(data.metrics.appointments.value)}</strong><span>{trendLabel(data.metrics.appointments)}</span></div>
              <div className="appointmentLegend">
                <span><i className="blueDot" />Scheduled <b>{formatNumber(data.appointmentStatus.scheduled)}</b></span>
                <span><i className="greenDot" />Completed <b>{formatNumber(data.appointmentStatus.completed)}</b></span>
                <span><i className="redDot" />Cancelled <b>{formatNumber(data.appointmentStatus.cancelled)}</b></span>
              </div>
              {hasAppointmentActivity ? <>
                <div className="barChart" aria-label="Appointments booked over time">
                  {chartSeries.map((item) => {
                    const height = item.appointments ? Math.max(8, Math.round((item.appointments / appointmentMax) * 110)) : 2;
                    const completedPercent = item.appointments ? (item.completedAppointments / item.appointments) * 100 : 0;
                    const cancelledPercent = item.appointments ? (item.cancelledAppointments / item.appointments) * 100 : 0;
                    return <span key={item.day} style={{ height: `${height}px` }} title={`${formatShortDate(item.day)}: ${item.appointments} appointments`}>
                      <i style={{ height: `${completedPercent}%` }} />
                      <em style={{ height: `${cancelledPercent}%`, top: `${completedPercent}%` }} />
                    </span>;
                  })}
                </div>
                <div className="barLabels">{chartSeries.map((item, index) => {
                  const show = index === 0 || index === chartSeries.length - 1 || index % Math.max(1, Math.ceil(chartSeries.length / 5)) === 0;
                  return show ? <span key={item.day}>{formatShortDate(item.day)}</span> : <span key={item.day} aria-hidden />;
                })}</div>
              </> : <EmptyCard text="No appointments were booked in this period." />}
            </article>
          </section>

          <section className="bottomGrid">
            <article className="dashboardCard activityCard">
              <div className="cardHeading"><h2>Recent activity</h2><Link href="/inbox">Open inbox</Link></div>
              <div className="activityList">
                {data.activity.map((item) => <Link className="activityRow" href={item.href} key={item.id}>
                  <span className={`activityIcon ${activityTone(item.kind)}`}>{activityIcon(item.kind)}</span>
                  <strong>{item.label}</strong>
                  <time dateTime={item.occurredAt}>{formatRelative(item.occurredAt)}</time>
                  <span className="activityTag">{item.detail}</span>
                </Link>)}
                {!data.activity.length && <EmptyCard text="No recent activity in this period." compact />}
              </div>
            </article>

            <article className="dashboardCard attentionCard">
              <div className="cardHeading"><h2>Needs attention {attentionTotal > 0 && <span className="attentionBadge">{attentionTotal}</span>}</h2></div>
              <div className="attentionList">
                <AttentionRow tone="red" icon={<AlertIcon />} title={`${data.attention.unansweredInquiries} unanswered ${data.attention.unansweredInquiries === 1 ? "inquiry" : "inquiries"}`} subtitle="Waiting more than 30 minutes" href="/inbox" />
                <AttentionRow tone="orange" icon={<CalendarIcon size={17} />} title={`${data.attention.pendingAppointments} ${data.attention.pendingAppointments === 1 ? "appointment needs" : "appointments need"} confirmation`} subtitle="Next 24 hours" href="/appointments" />
                <AttentionRow tone="blue" icon={<MessageIcon size={17} />} title={`${data.attention.qualifiedFollowups} qualified ${data.attention.qualifiedFollowups === 1 ? "lead" : "leads"} waiting for follow-up`} subtitle="No active appointment" href="/contacts" />
              </div>
            </article>

            <article className="dashboardCard creditCard">
              <div className="cardHeading"><h2>Credit balance</h2><Link href="/settings">View details</Link></div>
              <div className="creditContent">
                <div
                  className="creditDonut"
                  style={{ background: `conic-gradient(#1769ee 0 ${remainingPercent}%, #8fc8ff ${remainingPercent}% 100%)` } as CSSProperties}
                ><div><strong>{formatNumber(data.credit.balance)}</strong><span>credits left</span></div></div>
                <div className="creditLegend">
                  <span><i className="usedDot" />Used in period <b>{formatNumber(data.credit.usedInPeriod)}</b></span>
                  <span><i className="remainingDot" />Remaining <b>{formatNumber(data.credit.balance)}</b></span>
                </div>
              </div>
              <Link className="topupButton dashboardButtonLink primary" href="/settings">Manage credits</Link>
            </article>
          </section>
        </div>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  metric,
  tone,
  icon,
  values,
}: {
  label: string;
  metric: DashboardMetric;
  tone: string;
  icon: ReactNode;
  values: number[];
}) {
  return <article className="metricCard">
    <span className={`metricIcon ${tone}`}>{icon}</span>
    <strong className="metricValue">{formatNumber(metric.value)}</strong>
    <span className="metricLabel">{label}</span>
    <span className={`metricChange ${metric.changePercent !== null && metric.changePercent < 0 ? "down" : ""}`} title={`Previous period: ${formatNumber(metric.previousValue)}`}>{trendLabel(metric)}</span>
    {values.length > 0 && <svg className={`sparkline ${tone}`} viewBox="0 0 152 34" preserveAspectRatio="none" aria-hidden="true"><polyline points={sparkPoints(values)} /></svg>}
  </article>;
}

function AttentionRow({ tone, icon, title, subtitle, href }: { tone: string; icon: ReactNode; title: string; subtitle: string; href: string }) {
  return <Link href={href} className="attentionRow"><span className={`attentionIcon ${tone}`}>{icon}</span><div><strong>{title}</strong><small>{subtitle}</small></div><span className="attentionChevron">›</span></Link>;
}

function EmptyCard({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`dashboardEmpty ${compact ? "compact" : ""}`}>{text}</div>;
}

function AlertIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>;
}
