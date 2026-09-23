"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarIcon,
  ClockIcon,
  MessageIcon,
  UsersIcon,
} from "@/components/icons";
import { AppNav } from "@/components/core-domain/app-nav";
import { CustomAutomationHome } from "@/components/automations/custom-automation-home";
import "../dashboard/dashboard.css";
import "./automations.css";

type AutomationKey =
  | "MISSED_INQUIRY_RECOVERY"
  | "QUALIFIED_LEAD_ASSIGNMENT"
  | "APPOINTMENT_CONFIRMATION"
  | "APPOINTMENT_REMINDER"
  | "HUMAN_ESCALATION";

type AutomationSetting = {
  key: AutomationKey;
  enabled: boolean;
  config: Record<string, unknown>;
};

type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: "OWNER" | "ADMIN" | "STAFF";
};

type ActivityItem = {
  run: {
    id: string;
    key: AutomationKey | null;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "SKIPPED" | "FAILED";
    scheduledFor: string | null;
    completedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
    occurrenceKey: string;
  };
  workflow?: { name: string | null } | null;
  event: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    occurredAt: string;
  };
};

type Definition = {
  key: AutomationKey;
  title: string;
  description: string;
  tone: string;
  channels: string[];
};

const definitions: Definition[] = [
  {
    key: "MISSED_INQUIRY_RECOVERY",
    title: "Missed inquiry recovery",
    description: "Follow up only when an inbound inquiry received no newer reply.",
    tone: "red",
    channels: ["SMS", "WhatsApp"],
  },
  {
    key: "QUALIFIED_LEAD_ASSIGNMENT",
    title: "Qualified lead assignment",
    description: "Assign and notify your team when the qualification engine marks a lead qualified.",
    tone: "blue",
    channels: ["In-app"],
  },
  {
    key: "APPOINTMENT_CONFIRMATION",
    title: "Appointment confirmation",
    description: "Send a customer confirmation after a booking is persisted successfully.",
    tone: "green",
    channels: ["SMS", "WhatsApp"],
  },
  {
    key: "APPOINTMENT_REMINDER",
    title: "Appointment reminder",
    description: "Schedule one or two reminders before a confirmed appointment.",
    tone: "orange",
    channels: ["SMS", "WhatsApp"],
  },
  {
    key: "HUMAN_ESCALATION",
    title: "Human escalation",
    description: "Assign and notify a team member when the AI hands a conversation to a human.",
    tone: "purple",
    channels: ["In-app"],
  },
];

function configString(config: Record<string, unknown>, key: string, fallback = "") {
  return typeof config[key] === "string" ? String(config[key]) : fallback;
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number) {
  return typeof config[key] === "number" ? Number(config[key]) : fallback;
}

function configBoolean(config: Record<string, unknown>, key: string, fallback: boolean) {
  return typeof config[key] === "boolean" ? Boolean(config[key]) : fallback;
}

function configNullableString(config: Record<string, unknown>, key: string) {
  return typeof config[key] === "string" && String(config[key]).trim() ? String(config[key]) : null;
}

function configChannels(config: Record<string, unknown>, fallback: Array<"SMS" | "WHATSAPP"> = ["SMS"]) {
  const value = config.channels;
  if (!Array.isArray(value)) return fallback;
  const channels = value.filter((item): item is "SMS" | "WHATSAPP" => item === "SMS" || item === "WHATSAPP");
  return channels.length ? channels : fallback;
}

function humanKey(key: AutomationKey | null, workflowName?: string | null) {
  if (!key) return workflowName ?? "Custom automation";
  return definitions.find((item) => item.key === key)?.title ?? "Automation";
}

function channelLabel(channel: string) {
  return channel === "WHATSAPP" ? "WhatsApp" : channel;
}

export default function AutomationsPage() {
  const [settings, setSettings] = useState<AutomationSetting[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<AutomationKey | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AutomationKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [settingsResponse, teamResponse, activityResponse] = await Promise.all([
        fetch("/api/automations", { cache: "no-store" }),
        fetch("/api/team", { cache: "no-store" }),
        fetch("/api/automations/activity?limit=100", { cache: "no-store" }),
      ]);

      const settingsData = await settingsResponse.json().catch(() => null) as {
        settings?: AutomationSetting[];
        canManage?: boolean;
        error?: { message?: string };
      } | null;
      if (!settingsResponse.ok) throw new Error(settingsData?.error?.message ?? "Unable to load automations.");

      const teamData = await teamResponse.json().catch(() => null) as {
        members?: TeamMember[];
      } | null;
      const activityData = await activityResponse.json().catch(() => null) as {
        items?: ActivityItem[];
      } | null;

      setSettings(settingsData?.settings ?? []);
      setCanManage(Boolean(settingsData?.canManage));
      setMembers(teamResponse.ok ? teamData?.members ?? [] : []);
      setActivity(activityResponse.ok ? activityData?.items ?? [] : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const settingsByKey = useMemo(
    () => new Map(settings.map((setting) => [setting.key, setting])),
    [settings],
  );

  const metrics = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const counts = new Map<AutomationKey, number>();
    for (const item of activity) {
      if (new Date(item.run.createdAt).getTime() < cutoff) continue;
      if (item.run.status !== "COMPLETED" || !item.run.key) continue;
      counts.set(item.run.key, (counts.get(item.run.key) ?? 0) + 1);
    }
    return counts;
  }, [activity]);

  async function persistSetting(key: AutomationKey, enabled: boolean, config: Record<string, unknown>) {
    setSavingKey(key);
    setError(null);
    try {
      const response = await fetch(`/api/automations/${key}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, config }),
      });
      const data = await response.json().catch(() => null) as {
        setting?: AutomationSetting;
        error?: { message?: string };
      } | null;
      if (!response.ok || !data?.setting) {
        throw new Error(data?.error?.message ?? "Unable to save automation.");
      }
      setSettings((current) => current.map((item) => item.key === key ? data.setting! : item));
      return data.setting;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save automation.";
      setError(message);
      throw err;
    } finally {
      setSavingKey(null);
    }
  }

  async function toggle(key: AutomationKey) {
    const setting = settingsByKey.get(key);
    if (!setting || !canManage) return;
    await persistSetting(key, !setting.enabled, setting.config).catch(() => undefined);
  }

  const selected = selectedKey ? definitions.find((item) => item.key === selectedKey) ?? null : null;
  const selectedSetting = selectedKey ? settingsByKey.get(selectedKey) ?? null : null;

  return (
    <main className="appShell automationShell">
      <AppNav active="Automations" className="appSidebar automationSidebar" />

      <section className="appWorkspace automationWorkspace">
        <header className="automationTopbar">
          <div className="automationTopbarCopy"><strong>Automations</strong></div>
          <button type="button" className="activityLogButton" onClick={() => setActivityOpen((value) => !value)}>
            <ClockIcon size={16} />{activityOpen ? "Hide activity" : "View activity log"}
          </button>
        </header>

        <div className={`automationBody ${selected ? "drawerOpen" : ""}`}>
          <div className="automationTitleRow">
            <div><h1>Automations</h1></div>
            {!canManage && !loading && <span className="automationReadOnly">View only · Owner/Admin can edit</span>}
          </div>

          {error && <p className="automationError" role="alert">{error}</p>}

          {activityOpen && (
            <ActivityLog items={activity} loading={loading} />
          )}

          <div className="automationSectionHeading"><h2>Built-in automations</h2></div>
          <section className="automationList">
            {definitions.map((automation) => {
              const setting = settingsByKey.get(automation.key);
              const enabled = Boolean(setting?.enabled);
              return (
                <article
                  key={automation.key}
                  className={`automationCard ${selectedKey === automation.key ? "selected" : ""}`}
                  onClick={() => setSelectedKey(automation.key)}
                >
                  <span className={`automationIcon ${automation.tone}`}><WorkflowIcon automationKey={automation.key} /></span>
                  <div className="automationCopy">
                    <div className="automationNameRow">
                      <h2>{automation.title}</h2>
                      {enabled ? <span className="activePill">Active</span> : <span className="inactivePill">Paused</span>}
                    </div>
                    <p>{automation.description}</p>
                    <div className="automationChannels">
                      {automation.channels.map((channel) => <ChannelPill key={channel} channel={channel} />)}
                    </div>
                  </div>
                  <div className="automationControls">
                    <button
                      type="button"
                      className={`switch ${enabled ? "on" : ""}`}
                      aria-label={`${enabled ? "Disable" : "Enable"} ${automation.title}`}
                      disabled={!canManage || !setting || savingKey === automation.key}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggle(automation.key);
                      }}
                    ><i /></button>
                    <button
                      type="button"
                      className="editAutomation"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKey(automation.key);
                      }}
                    >{canManage ? "Edit" : "View"}</button>
                    <span className="automationChevron">›</span>
                  </div>
                  <div className="automationMetric">
                    <strong>{metrics.get(automation.key) ?? 0} completed</strong>
                    <small>Last 30 days</small>
                  </div>
                </article>
              );
            })}
            {loading && <div className="automationLoading">Loading workspace automations…</div>}
          </section>

          <CustomAutomationHome canManage={canManage} />
        </div>

        {selected && selectedSetting && (
          <AutomationDrawer
            definition={selected}
            setting={selectedSetting}
            members={members}
            canManage={canManage}
            saving={savingKey === selected.key}
            onClose={() => setSelectedKey(null)}
            onSave={persistSetting}
          />
        )}
      </section>
    </main>
  );
}

function AutomationDrawer({
  definition,
  setting,
  members,
  canManage,
  saving,
  onClose,
  onSave,
}: {
  definition: Definition;
  setting: AutomationSetting;
  members: TeamMember[];
  canManage: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (key: AutomationKey, enabled: boolean, config: Record<string, unknown>) => Promise<AutomationSetting>;
}) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(setting.config);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEnabled(setting.enabled);
    setConfig(setting.config);
    setSaved(false);
  }, [setting]);

  function update(key: string, value: unknown) {
    setConfig((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function save() {
    try {
      const result = await onSave(definition.key, enabled, config);
      setEnabled(result.enabled);
      setConfig(result.config);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      // The page-level error message is already populated.
    }
  }

  return (
    <aside className="automationDrawer" aria-label={`${definition.title} settings`}>
      <button type="button" className="drawerClose" onClick={onClose}>×</button>
      <header className="drawerHeader">
        <span className={`automationIcon ${definition.tone}`}><WorkflowIcon automationKey={definition.key} /></span>
        <div>
          <div className="drawerTitleLine">
            <h2>{definition.title}</h2>
            <span className={enabled ? "activePill" : "inactivePill"}>{enabled ? "Active" : "Paused"}</span>
          </div>
          <p>{definition.description}</p>
        </div>
      </header>

      <div className="drawerEnableRow">
        <span>Automation enabled</span>
        <button type="button" className={`switch ${enabled ? "on" : ""}`} disabled={!canManage} onClick={() => setEnabled((value) => !value)}><i /></button>
      </div>

      <AutomationSettingsForm definition={definition} config={config} members={members} disabled={!canManage} update={update} />

      <footer className="drawerFooter">
        <button type="button" className="cancelSettings" onClick={onClose}>Close</button>
        {canManage && <button type="button" className="saveAutomation" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : saved ? "Saved" : "Save changes"}</button>}
      </footer>
    </aside>
  );
}

function AutomationSettingsForm({
  definition,
  config,
  members,
  disabled,
  update,
}: {
  definition: Definition;
  config: Record<string, unknown>;
  members: TeamMember[];
  disabled: boolean;
  update: (key: string, value: unknown) => void;
}) {
  if (definition.key === "MISSED_INQUIRY_RECOVERY") {
    return <>
      <SettingsSection title="Recovery settings">
        <Field label="Wait before follow-up">
          <select disabled={disabled} value={configNumber(config, "delayMinutes", 15)} onChange={(event) => update("delayMinutes", Number(event.target.value))}>
            <option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option>
          </select>
        </Field>
        <CustomerChannels config={config} disabled={disabled} update={update} />
      </SettingsSection>
      <MessageEditor config={config} disabled={disabled} update={update} fallback="Hi {{name}}, we noticed we missed your message. Reply here and we’ll help you as soon as possible." />
    </>;
  }

  if (definition.key === "QUALIFIED_LEAD_ASSIGNMENT") {
    return <>
      <SettingsSection title="Lead routing">
        <AssigneeField config={config} members={members} disabled={disabled} update={update} />
        <CheckRow
          label="Create an in-app notification"
          checked={configBoolean(config, "notifyInApp", true)}
          disabled={disabled}
          onChange={(value) => update("notifyInApp", value)}
        />
      </SettingsSection>
      <AutomationNote>Leaving the assignee empty notifies the whole workspace without assigning the lead to one person.</AutomationNote>
    </>;
  }

  if (definition.key === "APPOINTMENT_CONFIRMATION") {
    return <>
      <SettingsSection title="Confirmation delivery">
        <CustomerChannels config={config} disabled={disabled} update={update} requireWhatsAppTemplate />
      </SettingsSection>
      <MessageEditor config={config} disabled={disabled} update={update} fallback="You’re booked, {{name}}. Your {{service}} appointment is confirmed for {{appointment_date}} at {{appointment_time}}." />
      <WhatsAppTemplateFields config={config} disabled={disabled} update={update} />
    </>;
  }

  if (definition.key === "APPOINTMENT_REMINDER") {
    const second = config.secondMinutesBefore === null ? null : configNumber(config, "secondMinutesBefore", 120);
    return <>
      <SettingsSection title="Reminder timing">
        <Field label="First reminder">
          <select disabled={disabled} value={configNumber(config, "firstMinutesBefore", 1440)} onChange={(event) => update("firstMinutesBefore", Number(event.target.value))}>
            <option value={2880}>48 hours before</option><option value={1440}>24 hours before</option><option value={720}>12 hours before</option><option value={120}>2 hours before</option>
          </select>
        </Field>
        <CheckRow
          label="Send a second reminder"
          checked={second !== null}
          disabled={disabled}
          onChange={(value) => update("secondMinutesBefore", value ? 120 : null)}
        />
        {second !== null && <Field label="Second reminder">
          <select disabled={disabled} value={second} onChange={(event) => update("secondMinutesBefore", Number(event.target.value))}>
            <option value={120}>2 hours before</option><option value={60}>1 hour before</option><option value={30}>30 minutes before</option>
          </select>
        </Field>}
        <CustomerChannels config={config} disabled={disabled} update={update} requireWhatsAppTemplate />
      </SettingsSection>
      <MessageEditor config={config} disabled={disabled} update={update} fallback="Reminder: your {{service}} appointment is {{appointment_date}} at {{appointment_time}}. Reply here if you need to reschedule." />
      <WhatsAppTemplateFields config={config} disabled={disabled} update={update} />
    </>;
  }

  return <>
    <SettingsSection title="Escalation routing">
      <AssigneeField config={config} members={members} disabled={disabled} update={update} />
      <CheckRow
        label="Create an in-app notification"
        checked={configBoolean(config, "notifyInApp", true)}
        disabled={disabled}
        onChange={(value) => update("notifyInApp", value)}
      />
    </SettingsSection>
    <AutomationNote>The AI’s ESCALATE tool remains the source of truth. This recipe only assigns and notifies after that escalation has already been persisted.</AutomationNote>
  </>;
}

function CustomerChannels({
  config,
  disabled,
  update,
  requireWhatsAppTemplate = false,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  update: (key: string, value: unknown) => void;
  requireWhatsAppTemplate?: boolean;
}) {
  const channels = configChannels(config);

  function toggle(channel: "SMS" | "WHATSAPP") {
    const has = channels.includes(channel);
    const next = has ? channels.filter((item) => item !== channel) : [...channels, channel];
    if (!next.length) return;
    update("channels", next);
  }

  return <div className="channelsSetting">
    <span className="fieldLabel">Channels</span>
    <div className="channelChecks">
      {(["SMS", "WHATSAPP"] as const).map((channel) => (
        <label key={channel}>
          <input type="checkbox" disabled={disabled} checked={channels.includes(channel)} onChange={() => toggle(channel)} />
          {channelLabel(channel)}
        </label>
      ))}
    </div>
    {requireWhatsAppTemplate && channels.includes("WHATSAPP") && <small className="automationInlineHint">WhatsApp requires an approved template for proactive confirmation/reminder delivery.</small>}
  </div>;
}

function WhatsAppTemplateFields({
  config,
  disabled,
  update,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  update: (key: string, value: unknown) => void;
}) {
  if (!configChannels(config).includes("WHATSAPP")) return null;
  return <SettingsSection title="WhatsApp template">
    <Field label="Approved template name">
      <input
        disabled={disabled}
        value={configNullableString(config, "whatsappTemplateName") ?? ""}
        onChange={(event) => update("whatsappTemplateName", event.target.value.trim() || null)}
        placeholder="appointment_reminder"
      />
    </Field>
    <Field label="Template language">
      <input
        disabled={disabled}
        value={configString(config, "whatsappTemplateLanguage", "en_US")}
        onChange={(event) => update("whatsappTemplateLanguage", event.target.value)}
        placeholder="en_US"
      />
    </Field>
  </SettingsSection>;
}

function AssigneeField({
  config,
  members,
  disabled,
  update,
}: {
  config: Record<string, unknown>;
  members: TeamMember[];
  disabled: boolean;
  update: (key: string, value: unknown) => void;
}) {
  return <Field label="Assign to">
    <select
      disabled={disabled}
      value={configNullableString(config, "assignedUserId") ?? ""}
      onChange={(event) => update("assignedUserId", event.target.value || null)}
    >
      <option value="">No fixed assignee</option>
      {members.map((member) => <option key={member.userId} value={member.userId}>{member.name} · {member.role}</option>)}
    </select>
  </Field>;
}

function MessageEditor({
  config,
  disabled,
  update,
  fallback,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  update: (key: string, value: unknown) => void;
  fallback: string;
}) {
  const [preview, setPreview] = useState(false);
  const value = configString(config, "message", fallback);
  return <section className="automationSettingsSection">
    <div className="settingsSectionHeading"><h3>Message content</h3></div>
    <div className="messageTabs">
      <button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Message</button>
      <button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button>
    </div>
    {preview
      ? <div className="messagePreview">{value
          .replaceAll("{{name}}", "Alex")
          .replaceAll("{{business_name}}", "Your Business")
          .replaceAll("{{service}}", "Consultation")
          .replaceAll("{{appointment_date}}", "Sep 18")
          .replaceAll("{{appointment_time}}", "10:00 AM")}</div>
      : <textarea className="automationTextarea" disabled={disabled} value={value} onChange={(event) => update("message", event.target.value)} />}
    <small className="variableHint">Variables: {"{{name}}"}, {"{{business_name}}"}, {"{{service}}"}, {"{{appointment_date}}"}, {"{{appointment_time}}"}</small>
  </section>;
}

function ActivityLog({ items, loading }: { items: ActivityItem[]; loading: boolean }) {
  return <section className="automationActivityPanel" aria-label="Automation activity">
    <div className="automationActivityHeader"><h2>Activity log</h2><span>{items.length} recent runs</span></div>
    {loading && <p className="automationActivityEmpty">Loading activity…</p>}
    {!loading && !items.length && <p className="automationActivityEmpty">No automation runs yet. Recipes are disabled until you explicitly enable them.</p>}
    {items.map((item) => (
      <div className="automationActivityRow" key={item.run.id}>
        <span className={`automationRunStatus ${item.run.status.toLowerCase()}`}>{item.run.status}</span>
        <div><strong>{humanKey(item.run.key, item.workflow?.name)}</strong><small>{item.event.type.replaceAll("_", " ")} · {new Date(item.run.createdAt).toLocaleString()}</small></div>
        <div className="automationActivityMeta">
          {item.run.scheduledFor && <small>Scheduled {new Date(item.run.scheduledFor).toLocaleString()}</small>}
          {item.run.errorMessage && <small className="automationActivityError">{item.run.errorMessage}</small>}
        </div>
      </div>
    ))}
  </section>;
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="automationSettingsSection"><div className="settingsSectionHeading"><h3>{title}</h3></div>{children}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="automationField"><span>{label}</span>{children}</label>;
}

function CheckRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return <label className="simpleCheck"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function AutomationNote({ children }: { children: React.ReactNode }) {
  return <p className="automationNote">{children}</p>;
}

function ChannelPill({ channel }: { channel: string }) {
  const icon = channel === "WhatsApp" ? "◉" : channel === "SMS" ? "▣" : "♢";
  return <span className={`workflowChannel ${channel.toLowerCase().replace(/\s+/g, "-")}`}><b>{icon}</b>{channel}</span>;
}

function WorkflowIcon({ automationKey }: { automationKey: AutomationKey }) {
  if (automationKey === "MISSED_INQUIRY_RECOVERY") return <RefreshIcon />;
  if (automationKey === "QUALIFIED_LEAD_ASSIGNMENT") return <UsersIcon size={21} />;
  if (automationKey === "APPOINTMENT_CONFIRMATION") return <CalendarIcon size={21} />;
  if (automationKey === "APPOINTMENT_REMINDER") return <ClockIcon size={21} />;
  return <MessageIcon size={21} />;
}

function RefreshIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M18 16a7 7 0 0 1-11.9 0L4 12"/></svg>;
}
