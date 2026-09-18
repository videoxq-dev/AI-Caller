"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  MessageIcon,
  UsersIcon,
} from "@/components/icons";
import { AppNav } from "@/components/core-domain/app-nav";
import { PhoneNumberManager } from "@/components/phone-number-manager";
import "../dashboard/dashboard.css";
import "./settings.css";

type SettingsTab = "general" | "phone" | "team" | "channels";
type ChannelId = "whatsapp" | "webchat";
type WorkspaceRole = "OWNER" | "ADMIN" | "STAFF";
type TeamMember = { userId: string; name: string; email: string; image: string | null; role: WorkspaceRole; joinedAt: string };
type TeamInvitation = { id: string; email: string; role: "ADMIN" | "STAFF"; status: "PENDING"; expiresAt: string; createdAt: string; invitedByUserId: string };
type TeamPlan = { id: "PERSONAL" | "GROWTH"; name: string; subUserLimit: number; activeSubUsers: number; pendingInvitations: number; usedSeats: number; availableSeats: number };

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "phone", label: "Phone & Messaging" },
  { id: "team", label: "Team" },
  { id: "channels", label: "Other channels" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");
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
  const [teamPlan, setTeamPlan] = useState<TeamPlan | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamActionPending, setTeamActionPending] = useState(false);
  const [channels, setChannels] = useState<Record<ChannelId, boolean>>({ whatsapp: true, webchat: true });

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
      const data = await response.json().catch(() => null) as { members?: TeamMember[]; invitations?: TeamInvitation[]; currentRole?: WorkspaceRole; plan?: TeamPlan; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Unable to load team.");
      setTeam(data?.members ?? []);
      setPendingInvitations(data?.invitations ?? []);
      setCurrentRole(data?.currentRole ?? null);
      setTeamPlan(data?.plan ?? null);
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
      <AppNav active="Settings" className="appSidebar settingsSidebar" />

      <section className="appWorkspace settingsWorkspace">
        <header className="settingsTopbar">
          <label className="settingsGlobalSearch"><SearchIcon /><input placeholder="Search contacts, appointments, or settings..." /><kbd>⌘ K</kbd></label>
          <div className="settingsTopActions">
            <Link className="settingsBillingTopLink" href="/settings/billing">Billing &amp; Usage</Link>
          </div>
        </header>

        <div className="settingsBody">
          <div className="settingsTitleRow">
            <div><h1>Settings</h1><p>Manage your account, team, channels and billing.</p></div>
            {tab !== "team" && tab !== "phone" && <button className="settingsSaveButton" type="button" onClick={save}>{saved ? "Saved" : "Save changes"}</button>}
          </div>

          <div className="settingsTabs settingsTabsWithBilling" role="tablist" aria-label="Settings sections">
            {settingsTabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
            <Link className="settingsBillingTabLink" href="/settings/billing">Billing &amp; Usage</Link>
          </div>

          {tab === "general" && (
            <GeneralTab businessName={businessName} setBusinessName={setBusinessName} timezone={timezone} setTimezone={setTimezone} language={language} setLanguage={setLanguage} notificationEmail={notificationEmail} setNotificationEmail={setNotificationEmail} />
          )}

          {tab === "phone" && (
            <section className="settingsPhoneSection">
              <article className="settingsCard phoneManagementCard">
                <div className="sectionHeading"><div><h2>Phone &amp; Messaging</h2><p>Manage the AI Caller number customers use for both calls and SMS.</p></div><span className="statusPill">Managed by AI Caller</span></div>
                <div className="settingsPhoneManager"><PhoneNumberManager settingsMode /></div>
              </article>
              <aside className="settingsCard compactCard phoneBillingHelp">
                <h2>How billing works</h2>
                <p className="compactCopy">Your number renews monthly from your credit balance. Calls, SMS and AI usage are metered separately.</p>
                <Link className="settingsOutlineLink" href="/settings/billing">Credits &amp; usage</Link>
                <p className="compactCopy">If renewal cannot be charged, a 7-day grace period starts before phone service is suspended. Adding enough credits reactivates it automatically.</p>
              </aside>
            </section>
          )}

          {tab === "team" && (
            <section className="settingsGrid settingsGridTeam">
              <article className="settingsCard">
                <div className="sectionHeading"><div><h2>Team</h2><p>{teamPlan ? `${teamPlan.name} · ${teamPlan.usedSeats} of ${teamPlan.subUserLimit} sub-user seats used` : `${activeMembers} active members`}</p></div><span className="statusPill">{team.length + pendingInvitations.length} total</span></div>
                {teamError && <p className="teamSettingsError" role="alert">{teamError}</p>}
                {teamPlan?.subUserLimit === 0 && canManageTeam && <div className="teamPlanNotice"><span>Personal is owner-only. Growth enables up to 3 sub-users.</span><Link href="/settings/billing">View billing &amp; plan</Link></div>}
                {canManageTeam && teamPlan?.subUserLimit !== 0 && <div className="inviteRow"><input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@business.com" type="email" /><select aria-label="Invitation role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "ADMIN" | "STAFF")}><option value="STAFF">Staff</option>{currentRole === "OWNER" && <option value="ADMIN">Admin</option>}</select><button type="button" disabled={teamActionPending || !inviteEmail.trim()} onClick={() => void invite()}>Invite member</button></div>}
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
              <ChannelCard title="WhatsApp" provider="Meta connection" active={channels.whatsapp} onToggle={() => setChannels((current) => ({ ...current, whatsapp: !current.whatsapp }))} icon={<WhatsAppIcon />} detail="Business messaging" />
              <ChannelCard title="Web Chat" provider="AI Caller widget" active={channels.webchat} onToggle={() => setChannels((current) => ({ ...current, webchat: !current.webchat }))} icon={<MessageIcon size={20} />} detail="Website conversations" />
              <article className="settingsCard channelRoutingCard"><div className="sectionHeading"><div><h2>Channel routing</h2><p>Shared handling rules</p></div></div><SettingToggle title="Allow AI to respond first" text="Human takeover remains available at any time." on /><SettingToggle title="Escalate when AI is unsure" text="Move the conversation to a human agent." on /><SettingToggle title="Notify team on takeover" text="Send an in-app notification when escalation happens." on /></article>
              <article className="settingsCard compactCard"><h2>Other channel setup</h2><p className="compactCopy">Manage WhatsApp and calendar connections from Integrations. Phone and SMS are managed directly by AI Caller.</p><Link className="settingsOutlineLink" href="/integrations">Manage integrations</Link></article>
            </section>
          )}
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

function ChannelCard({ title, provider, active, onToggle, icon, detail }: { title: string; provider: string; active: boolean; onToggle: () => void; icon: ReactNode; detail: string }) {
  return <article className="settingsCard channelCard"><div className="channelCardTop"><span className="channelIcon">{icon}</span><div><h2>{title}</h2><p>{detail}</p></div><button type="button" className={`switch ${active ? "on" : ""}`} onClick={onToggle} aria-label={`Toggle ${title}`}><i /></button></div><div className="channelProvider"><span>Provider</span><strong>{provider}</strong></div><Link className="settingsOutlineLink" href="/integrations">Manage provider</Link></article>;
}

function SettingToggle({ title, text, on }: { title: string; text: string; on: boolean }) {
  return <div className="settingToggleRow"><div><strong>{title}</strong><small>{text}</small></div><span className={`switch static ${on ? "on" : ""}`}><i /></span></div>;
}

function RoleLine({ title, text }: { title: string; text: string }) { return <div className="roleLine"><span><UsersIcon size={16} /></span><div><strong>{title}</strong><small>{text}</small></div></div>; }
function SearchIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>; }
function WhatsAppIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 11.8A8.5 8.5 0 0 1 8 19.3L3.5 21l1.6-4.2A8.5 8.5 0 1 1 20.5 11.8Z"/><path d="M8.4 8.1c.4 3 2.4 5 5.4 5.8l1.2-1.4 2.2.9c-.5 1.8-1.8 2.6-3.6 2.3-4.2-.7-7.3-3.8-8-8-.3-1.8.5-3.1 2.3-3.6l.9 2.2-1.4 1.2"/></svg>; }