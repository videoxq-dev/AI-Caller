"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CheckIcon,
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
import "./settings.css";

type SettingsTab = "general" | "team" | "channels" | "usage" | "billing";
type ChannelId = "voice" | "sms" | "whatsapp" | "webchat";
type WorkspaceRole = "OWNER" | "ADMIN" | "STAFF";
type TeamMember = { userId: string; name: string; email: string; image: string | null; role: WorkspaceRole; joinedAt: string };
type TeamInvitation = { id: string; email: string; role: "ADMIN" | "STAFF"; status: "PENDING"; expiresAt: string; createdAt: string; invitedByUserId: string };

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <HomeIcon /> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} />, badge: "3" },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <BotIcon /> },
  { label: "Automations", href: "/automations", icon: <BoltIcon /> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} />, active: true },
];

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "team", label: "Team" },
  { id: "channels", label: "Channels" },
  { id: "usage", label: "Usage & Credits" },
  { id: "billing", label: "Billing" },
];

const usageRows = [
  { channel: "AI", provider: "Our Credits", usage: "12,480 tokens", remaining: "87,520", status: "Active", percent: 13, tone: "blue", icon: <BotIcon /> },
  { channel: "SMS", provider: "Telnyx — BYOP", usage: "892 messages", remaining: "Unlimited", status: "Connected", percent: 16, tone: "purple", icon: <MessageIcon size={17} /> },
  { channel: "Voice", provider: "Telnyx — BYOP", usage: "248 minutes", remaining: "Unlimited", status: "Connected", percent: 28, tone: "blue", icon: <PhoneIcon size={17} /> },
  { channel: "WhatsApp", provider: "Meta — BYOP", usage: "1,204 messages", remaining: "Unlimited", status: "Connected", percent: 22, tone: "green", icon: <WhatsAppIcon /> },
  { channel: "Calendar", provider: "Calendly", usage: "342 bookings", remaining: "Unlimited", status: "Connected", percent: 34, tone: "cyan", icon: <CalendarIcon size={17} /> },
];

const invoices = [
  { date: "Sep 1, 2026", description: "Core plan", amount: "$29.00", status: "Paid" },
  { date: "Aug 1, 2026", description: "Core plan", amount: "$29.00", status: "Paid" },
  { date: "Jul 1, 2026", description: "Core plan", amount: "$29.00", status: "Paid" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("usage");
  const [saved, setSaved] = useState(false);
  const [businessName, setBusinessName] = useState("Wellness Juvi");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [language, setLanguage] = useState("English");
  const [notificationEmail, setNotificationEmail] = useState("bella@wellnessjuvi.com");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "STAFF">("STAFF");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<TeamInvitation[]>([]);
  const [currentRole, setCurrentRole] = useState<WorkspaceRole | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamActionPending, setTeamActionPending] = useState(false);
  const [channels, setChannels] = useState<Record<ChannelId, boolean>>({ voice: true, sms: true, whatsapp: true, webchat: true });

  const activeMembers = team.length;
  const canManageTeam = currentRole === "OWNER" || currentRole === "ADMIN";

  const save = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  async function loadTeam() {
    setTeamLoading(true);
    setTeamError(null);
    try {
      const response = await fetch("/api/team", { cache: "no-store" });
      const data = await response.json().catch(() => null) as { members?: TeamMember[]; invitations?: TeamInvitation[]; currentRole?: WorkspaceRole; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to load team.");
      setTeam(data?.members ?? []);
      setPendingInvitations(data?.invitations ?? []);
      setCurrentRole(data?.currentRole ?? null);
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Unable to load team.");
    } finally {
      setTeamLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "team") void loadTeam();
  }, [tab]);

  async function invite() {
    const email = inviteEmail.trim();
    if (!email || !canManageTeam) return;
    setTeamActionPending(true);
    setTeamError(null);
    try {
      const response = await fetch("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to invite team member.");
      setInviteEmail("");
      setInviteRole("STAFF");
      await loadTeam();
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Unable to invite team member.");
    } finally {
      setTeamActionPending(false);
    }
  }

  async function changeMemberRole(member: TeamMember, role: "ADMIN" | "STAFF") {
    setTeamActionPending(true);
    setTeamError(null);
    try {
      const response = await fetch(`/api/team/members/${member.userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to update team member.");
      await loadTeam();
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Unable to update team member.");
    } finally {
      setTeamActionPending(false);
    }
  }

  async function removeMember(member: TeamMember) {
    setTeamActionPending(true);
    setTeamError(null);
    try {
      const response = await fetch(`/api/team/members/${member.userId}`, { method: "DELETE" });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to remove team member.");
      await loadTeam();
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Unable to remove team member.");
    } finally {
      setTeamActionPending(false);
    }
  }

  async function revokeInvitation(invitation: TeamInvitation) {
    setTeamActionPending(true);
    setTeamError(null);
    try {
      const response = await fetch(`/api/team/invitations/${invitation.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to revoke invitation.");
      await loadTeam();
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Unable to revoke invitation.");
    } finally {
      setTeamActionPending(false);
    }
  }

  return (
    <main className="appShell settingsShell">
      <aside className="appSidebar settingsSidebar">
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
        <a className="settingsHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
      </aside>

      <section className="appWorkspace settingsWorkspace">
        <header className="settingsTopbar">
          <label className="settingsGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, or settings..." /><kbd>⌘ K</kbd></label>
          <div className="settingsTopActions">
            <button className="settingsAgentStatus" type="button"><i />AI Agent Online <ChevronDown /></button>
            <button className="settingsCredit" type="button"><DatabaseIcon size={15} />2,480 credits</button>
            <button className="settingsBell" type="button" aria-label="Notifications">♧<i /></button>
            <div className="profileBlock settingsProfile"><span className="avatar">B</span><span className="profileCopy"><strong>Bella</strong><small>Wellness Juvi</small></span><ChevronDown /></div>
          </div>
        </header>

        <div className="settingsBody">
          <div className="settingsTitleRow">
            <div><h1>Settings</h1><p>Manage your account, team, channels and billing.</p></div>
            {tab !== "usage" && tab !== "team" && <button className="settingsSaveButton" type="button" onClick={save}>{saved ? "Saved" : "Save changes"}</button>}
          </div>

          <div className="settingsTabs" role="tablist" aria-label="Settings sections">
            {settingsTabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
          </div>

          {tab === "general" && (
            <GeneralTab businessName={businessName} setBusinessName={setBusinessName} timezone={timezone} setTimezone={setTimezone} language={language} setLanguage={setLanguage} notificationEmail={notificationEmail} setNotificationEmail={setNotificationEmail} />
          )}

          {tab === "team" && (
            <section className="settingsGrid settingsGridTeam">
              <article className="settingsCard">
                <div className="sectionHeading"><div><h2>Team</h2><p>{activeMembers} active members</p></div><span className="statusPill">{team.length + pendingInvitations.length} total</span></div>
                {teamError && <p className="teamSettingsError" role="alert">{teamError}</p>}
                {canManageTeam && <div className="inviteRow"><input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@business.com" type="email" /><select aria-label="Invitation role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "ADMIN" | "STAFF")}><option value="STAFF">Staff</option>{currentRole === "OWNER" && <option value="ADMIN">Admin</option>}</select><button type="button" disabled={teamActionPending || !inviteEmail.trim()} onClick={() => void invite()}>Invite member</button></div>}
                <div className="teamTable">
                  {teamLoading && !team.length && <div className="teamEmpty">Loading team…</div>}
                  {team.map((member) => {
                    const protectedMember = member.role === "OWNER" || (currentRole === "ADMIN" && member.role === "ADMIN");
                    const editable = canManageTeam && !protectedMember;
                    return (
                      <div className="teamRow" key={member.userId}>
                        <span className="teamAvatar">{member.name.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{member.name}</strong><small>{member.email}</small></div>
                        <select value={member.role} onChange={(event) => void changeMemberRole(member, event.target.value as "ADMIN" | "STAFF")} disabled={!editable || teamActionPending}>
                          {member.role === "OWNER" && <option value="OWNER">Owner</option>}
                          {currentRole === "OWNER" && <option value="ADMIN">Admin</option>}
                          <option value="STAFF">Staff</option>
                        </select>
                        <span className="memberStatus active">Active</span>
                        {editable ? <button type="button" className="rowMenu teamRemove" disabled={teamActionPending} onClick={() => void removeMember(member)}>Remove</button> : <span className="rowMenuPlaceholder" />}
                      </div>
                    );
                  })}
                  {pendingInvitations.map((invitation) => {
                    const canRevoke = canManageTeam && !(currentRole === "ADMIN" && invitation.role === "ADMIN");
                    return (
                      <div className="teamRow pendingTeamRow" key={invitation.id}>
                        <span className="teamAvatar">?</span>
                        <div><strong>{invitation.email}</strong><small>Invitation expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></div>
                        <span className="teamRoleText">{invitation.role === "ADMIN" ? "Admin" : "Staff"}</span>
                        <span className="memberStatus invited">Invited</span>
                        {canRevoke ? <button type="button" className="rowMenu teamRemove" disabled={teamActionPending} onClick={() => void revokeInvitation(invitation)}>Revoke</button> : <span className="rowMenuPlaceholder" />}
                      </div>
                    );
                  })}
                  {!teamLoading && !team.length && !pendingInvitations.length && <div className="teamEmpty">No team members yet.</div>}
                </div>
              </article>
              <aside className="settingsCard compactCard"><h2>Roles</h2><RoleLine title="Owner" text="Full workspace and billing access" /><RoleLine title="Admin" text="Manage team, conversations and automations" /><RoleLine title="Staff" text="Inbox, takeover, replies and self-assignment" /></aside>
            </section>
          )}

          {tab === "channels" && (
            <section className="channelSettingsGrid">
              <ChannelCard title="Voice" provider="Telnyx — BYOP" active={channels.voice} onToggle={() => setChannels((current) => ({ ...current, voice: !current.voice }))} icon={<PhoneIcon size={20} />} detail="Inbound calls" />
              <ChannelCard title="SMS" provider="Telnyx — BYOP" active={channels.sms} onToggle={() => setChannels((current) => ({ ...current, sms: !current.sms }))} icon={<MessageIcon size={20} />} detail="Two-way messaging" />
              <ChannelCard title="WhatsApp" provider="Meta — BYOP" active={channels.whatsapp} onToggle={() => setChannels((current) => ({ ...current, whatsapp: !current.whatsapp }))} icon={<WhatsAppIcon />} detail="Business messaging" />
              <ChannelCard title="Web Chat" provider="AI Caller widget" active={channels.webchat} onToggle={() => setChannels((current) => ({ ...current, webchat: !current.webchat }))} icon={<MessageIcon size={20} />} detail="Website conversations" />
              <article className="settingsCard channelRoutingCard"><div className="sectionHeading"><div><h2>Channel routing</h2><p>Shared handling rules</p></div></div><SettingToggle title="Allow AI to respond first" text="Human takeover remains available at any time." on /><SettingToggle title="Escalate when AI is unsure" text="Move the conversation to a human agent." on /><SettingToggle title="Notify team on takeover" text="Send an in-app notification when escalation happens." on /></article>
              <article className="settingsCard compactCard"><h2>Provider setup</h2><p className="compactCopy">Update API credentials and provider connections from Integrations.</p><Link className="settingsOutlineLink" href="/integrations">Manage integrations</Link></article>
            </section>
          )}

          {tab === "usage" && <UsageTab />}

          {tab === "billing" && <BillingTab />}
        </div>
      </section>
    </main>
  );
}

function GeneralTab({ businessName, setBusinessName, timezone, setTimezone, language, setLanguage, notificationEmail, setNotificationEmail }: { businessName: string; setBusinessName: (value: string) => void; timezone: string; setTimezone: (value: string) => void; language: string; setLanguage: (value: string) => void; notificationEmail: string; setNotificationEmail: (value: string) => void }) {
  return <section className="settingsGrid">
    <article className="settingsCard">
      <div className="sectionHeading"><div><h2>Business details</h2><p>Default account information.</p></div></div>
      <div className="settingsFormGrid">
        <label><span>Business name</span><input value={businessName} onChange={(event) => setBusinessName(event.target.value)} /></label>
        <label><span>Notification email</span><input value={notificationEmail} onChange={(event) => setNotificationEmail(event.target.value)} type="email" /></label>
        <label><span>Timezone</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="Africa/Lagos">West Africa Time (Lagos)</option><option value="America/New_York">Eastern Time</option><option value="America/Chicago">Central Time</option><option value="America/Los_Angeles">Pacific Time</option></select></label>
        <label><span>Language</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option>English</option><option>Spanish</option><option>French</option></select></label>
      </div>
    </article>
    <aside className="settingsCard compactCard"><h2>Account</h2><SettingToggle title="Weekly performance email" text="Receive a weekly summary of conversations and bookings." on /><SettingToggle title="Product updates" text="Receive important product announcements." on={false} /></aside>
  </section>;
}

function UsageTab() {
  return <section className="usageLayout">
    <div className="usageMain">
      <article className="settingsCard usageHeroCard">
        <div className="sectionHeading"><div><h2>Usage & Credits</h2><p>Current usage across hosted credits and BYOP services.</p></div><button type="button" className="datePill"><CalendarIcon size={15} />Last 30 days <ChevronDown /></button></div>
        <div className="usageMetrics">
          <UsageMetric label="Total conversations" value="1,248" change="↑ 12%" icon={<MessageIcon size={19} />} />
          <UsageMetric label="Appointments booked" value="342" change="↑ 18%" icon={<CalendarIcon size={19} />} />
          <UsageMetric label="Messages sent" value="4,892" change="↑ 24%" icon={<SendIcon />} />
          <UsageMetric label="Hosted cost" value="$12.40" change="↓ 18%" icon={<DatabaseIcon size={19} />} />
        </div>
      </article>

      <article className="settingsCard usageProvidersCard">
        <div className="sectionHeading"><div><h2>Channel usage and providers</h2><p>See which provider powers each channel.</p></div></div>
        <div className="usageTable">
          <div className="usageTableHead"><span>Channel</span><span>Provider</span><span>Usage (30 days)</span><span>Remaining</span><span>Status</span><span>Actions</span></div>
          {usageRows.map((row) => <div className="usageTableRow" key={row.channel}>
            <div className={`usageChannel ${row.tone}`}><span>{row.icon}</span><strong>{row.channel}</strong></div>
            <strong className="providerName">{row.provider}</strong>
            <div className="usageAmount"><span>{row.usage}</span><i><b style={{ width: `${row.percent}%` }} /></i></div>
            <span>{row.remaining}</span>
            <span className="connectedStatus"><i />{row.status}</span>
            <Link href="/integrations">Manage</Link>
          </div>)}
        </div>
      </article>

      <div className="usageChartsGrid">
        <article className="settingsCard"><div className="sectionHeading"><div><h2>Usage over time</h2></div><span className="miniSelect">Last 30 days</span></div><div className="usageChart"><div className="chartLegendRow"><span><i className="dot blue" />AI</span><span><i className="dot green" />SMS</span><span><i className="dot purple" />Voice</span><span><i className="dot orange" />WhatsApp</span><span><i className="dot cyan" />Calendar</span></div><div className="chartArea">{[42,58,49,63,55,70,66,82,72,91,76,84].map((value, index) => <span key={index}><i style={{ height: `${value}%` }} /></span>)}</div></div></article>
        <article className="settingsCard breakdownCard"><div className="sectionHeading"><div><h2>Usage breakdown</h2></div></div><div className="usageDonut"><div><strong>4,892</strong><span>Total</span></div></div><div className="breakdownLegend"><Legend label="AI" value="36%" tone="blue" /><Legend label="SMS" value="22%" tone="green" /><Legend label="WhatsApp" value="24%" tone="purple" /><Legend label="Voice" value="13%" tone="orange" /><Legend label="Calendar" value="5%" tone="cyan" /></div></article>
      </div>
    </div>

    <aside className="usageAside">
      <article className="settingsCard creditBalanceCard"><div className="creditTitle"><span><DatabaseIcon size={19} /></span><h2>Our Credits</h2><button type="button">Top up</button></div><strong className="bigCredit">87,520</strong><small>credits remaining</small><div className="creditProgress"><i><b style={{ width: "13%" }} /></i><div><span>12,480 used of 100,000</span><strong>13%</strong></div></div><p className="creditNote">Hosted credits are used when AI is set to Our Credits.</p><button className="textLinkButton" type="button">View usage details →</button></article>
      <article className="settingsCard quickLinksCard"><h2>Quick links</h2><QuickLink href="/integrations" title="Manage integrations" text="Connect or update providers" icon={<GearIcon size={17} />} /><QuickLink href="#billing" title="View billing" text="Invoices and payment history" icon={<BillingIcon />} /><QuickLink href="#limits" title="Set usage limits" text="Spending and alerts" icon={<ClockIcon size={17} />} /><QuickLink href="#report" title="Download usage report" text="Export detailed usage" icon={<DownloadIcon />} /></article>
      <article className="settingsCard compactCard"><h2>Need help?</h2><p className="compactCopy">Usage, providers and billing support.</p><button type="button" className="settingsOutlineLink buttonLink">Usage & billing docs</button><button type="button" className="settingsOutlineLink buttonLink">Contact support</button></article>
    </aside>
  </section>;
}

function BillingTab() {
  return <section className="settingsGrid billingGrid">
    <div className="billingMain">
      <article className="settingsCard planCard"><div className="sectionHeading"><div><h2>Current plan</h2><p>Core plan</p></div><span className="planPrice">$29<span>/month</span></span></div><div className="planUsage"><div><span>Hosted credits</span><strong>100,000 / month</strong></div><div><span>Team members</span><strong>3 included</strong></div><div><span>Automations</span><strong>5 active</strong></div></div><div className="planActions"><button type="button" className="primaryAction">Manage subscription</button><button type="button" className="secondaryAction">Change plan</button></div></article>
      <article className="settingsCard"><div className="sectionHeading"><div><h2>Billing history</h2><p>Recent invoices</p></div></div><div className="invoiceTable"><div className="invoiceHead"><span>Date</span><span>Description</span><span>Amount</span><span>Status</span><span /></div>{invoices.map((invoice) => <div className="invoiceRow" key={invoice.date}><span>{invoice.date}</span><strong>{invoice.description}</strong><span>{invoice.amount}</span><span className="paidBadge">{invoice.status}</span><button type="button">Download</button></div>)}</div></article>
    </div>
    <aside className="billingAside"><article className="settingsCard"><h2>Payment method</h2><div className="paymentMethod"><span className="cardMark">VISA</span><div><strong>•••• 4242</strong><small>Expires 12/28</small></div></div><button className="settingsOutlineLink buttonLink" type="button">Update payment method</button></article><article className="settingsCard"><h2>Billing email</h2><p className="compactCopy">Invoices are sent to:</p><strong className="billingEmail">bella@wellnessjuvi.com</strong><button className="settingsOutlineLink buttonLink" type="button">Edit billing details</button></article></aside>
  </section>;
}

function UsageMetric({ label, value, change, icon }: { label: string; value: string; change: string; icon: ReactNode }) {
  return <div className="usageMetric"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{change}</em></div></div>;
}

function ChannelCard({ title, provider, active, onToggle, icon, detail }: { title: string; provider: string; active: boolean; onToggle: () => void; icon: ReactNode; detail: string }) {
  return <article className="settingsCard channelCard"><div className="channelCardTop"><span className="channelIcon">{icon}</span><div><h2>{title}</h2><p>{detail}</p></div><button type="button" className={`switch ${active ? "on" : ""}`} onClick={onToggle} aria-label={`Toggle ${title}`}><i /></button></div><div className="channelProvider"><span>Provider</span><strong>{provider}</strong></div><Link className="settingsOutlineLink" href="/integrations">Manage provider</Link></article>;
}

function SettingToggle({ title, text, on }: { title: string; text: string; on: boolean }) {
  return <div className="settingToggleRow"><div><strong>{title}</strong><small>{text}</small></div><span className={`switch static ${on ? "on" : ""}`}><i /></span></div>;
}

function RoleLine({ title, text }: { title: string; text: string }) { return <div className="roleLine"><span><UsersIcon size={16} /></span><div><strong>{title}</strong><small>{text}</small></div></div>; }
function Legend({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="legendLine"><span><i className={`dot ${tone}`} />{label}</span><strong>{value}</strong></div>; }
function QuickLink({ href, title, text, icon }: { href: string; title: string; text: string; icon: ReactNode }) { return <Link className="quickLink" href={href}><span>{icon}</span><div><strong>{title}</strong><small>{text}</small></div><b>›</b></Link>; }

function SearchIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function HomeIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8v10H6a3 3 0 0 1-3-3Z"/><path d="M9 21v-7h6v7"/></svg>; }
function BotIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></svg>; }
function BoltIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg>; }
function ChevronDown() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6"/></svg>; }
function WhatsAppIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 11.8A8.5 8.5 0 0 1 8 19.3L3.5 21l1.6-4.2A8.5 8.5 0 1 1 20.5 11.8Z"/><path d="M8.4 8.1c.4 3 2.4 5 5.4 5.8l1.2-1.4 2.2.9c-.5 1.8-1.8 2.6-3.6 2.3-4.2-.7-7.3-3.8-8-8-.3-1.8.5-3.1 2.3-3.6l.9 2.2-1.4 1.2"/></svg>; }
function SendIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>; }
function BillingIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>; }
function DownloadIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>; }
