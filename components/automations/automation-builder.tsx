"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppNav } from "@/components/core-domain/app-nav";
import "@/app/dashboard/dashboard.css";

type TriggerId =
  | "INQUIRY_RECEIVED"
  | "LEAD_QUALIFIED"
  | "APPOINTMENT_CONFIRMED"
  | "APPOINTMENT_RESCHEDULED"
  | "APPOINTMENT_CANCELLED"
  | "CONVERSATION_ESCALATED";
type ConditionField = "qualificationScore" | "channel";
type Operator = "EQ" | "GTE" | "LTE";
type Action =
  | { type: "ASSIGN_LEAD"; userId: string }
  | { type: "NOTIFY_STAFF"; userId: string | null; title: string; message: string }
  | { type: "SEND_CUSTOMER_SMS"; message: string }
  | { type: "SEND_CUSTOMER_WHATSAPP"; templateName: string; languageCode: string; variables: string[] };
type Condition =
  | { field: "qualificationScore"; operator: Operator; value: number }
  | { field: "channel"; operator: "EQ"; value: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT" };
type WorkflowDraft = {
  trigger: TriggerId;
  match: "ALL" | "ANY";
  conditions: Condition[];
  actions: Action[];
};
type BuilderWorkflow = {
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  draft: WorkflowDraft;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
};
type TeamMember = { userId: string; name: string; email: string; role: string };
type TriggerCatalog = {
  id: TriggerId;
  label: string;
  conditions: readonly ConditionField[];
  actions: readonly Action["type"][];
  variables: readonly string[];
};
type Catalog = {
  triggers: TriggerCatalog[];
  conditions: {
    qualificationScore: {
      label: string;
      kind: "number";
      min: number;
      max: number;
      operators: Array<{ id: Operator; label: string }>;
    };
    channel: {
      label: string;
      kind: "select";
      operators: Array<{ id: "EQ"; label: string }>;
      options: Array<{ id: "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT"; label: string }>;
    };
  };
  actions: Array<{ id: Action["type"]; label: string }>;
  variables: Array<{ id: string; label: string }>;
  maxActions: number;
};
type WhatsAppTemplate = {
  name: string; language: string; category: "UTILITY" | "MARKETING";
  status: string; body: string;
};
type SmsReadiness = {
  status: "NOT_CONFIGURED" | "PROVIDER_DISCONNECTED" | "CARRIER_UNVERIFIED"
    | "REGISTRATION_REQUIRED" | "IN_REVIEW" | "REJECTED" | "PHONE_SUSPENDED" | "READY";
  categories: Array<"TRANSACTIONAL" | "MARKETING">;
  message: string;
  setupUrl: string;
};
type TestResult = {
  matches: boolean;
  conditions: Array<{
    field: string;
    operator: string;
    actual: unknown;
    expected: unknown;
    matched: boolean;
  }>;
  actions: Array<{ type: Action["type"]; label: string; userId?: string | null; title?: string }>;
};
type ActivityItem = {
  run: {
    id: string;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "SKIPPED" | "FAILED" | "CANCELLED";
    createdAt: string;
    errorMessage: string | null;
  };
  actions: Array<{
    actionIndex: number;
    actionType: Action["type"];
    status: "PENDING" | "RUNNING" | "COMPLETED" | "SKIPPED" | "FAILED" | "UNKNOWN" | "CANCELLED";
    errorCode: string | null;
    errorMessage: string | null;
  }>;
};

function responseMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const error = (data as { error?: { message?: string } }).error;
  return error?.message ?? fallback;
}

function statusLabel(status: BuilderWorkflow["status"]) {
  if (status === "ACTIVE") return "Active";
  if (status === "PAUSED") return "Paused";
  return "Draft";
}

function actionName(type: Action["type"]) {
  if (type === "ASSIGN_LEAD") return "Assign lead";
  if (type === "NOTIFY_STAFF") return "Notify";
  if (type === "SEND_CUSTOMER_WHATSAPP") return "Send approved WhatsApp template";
  return "Send customer an SMS";
}

function runStatus(status: ActivityItem["run"]["status"]) {
  if (status === "COMPLETED") return "Completed";
  if (status === "SKIPPED") return "Skipped";
  if (status === "FAILED") return "Failed";
  if (status === "CANCELLED") return "Cancelled";
  if (status === "RUNNING") return "Running";
  return "Pending";
}

function actionOutcome(action: ActivityItem["actions"][number]) {
  if (action.status === "UNKNOWN" || action.errorCode === "INTERRUPTED_DELIVERY") {
    return "Could not confirm delivery. It was not sent again automatically.";
  }
  if (action.errorCode === "SMS_CONSENT_REQUIRED") return "Customer has not opted in to this type of SMS, or has opted out."; 
  if (action.errorCode === "SMS_REGISTRATION_REQUIRED" || action.errorCode === "SMS_CAMPAIGN_NOT_APPROVED")
    return "SMS business registration is not approved yet.";
  if (action.errorCode === "SMS_REGISTRATION_REJECTED") return "SMS business registration needs attention.";
  if (action.errorCode === "SMS_CAMPAIGN_PURPOSE_NOT_APPROVED") return "This message type is outside the approved SMS campaign.";
  if (action.errorCode === "SMS_CAMPAIGN_LINKS_NOT_APPROVED") return "Links are not approved for this SMS campaign.";
  if (action.errorCode?.startsWith("SMS_CAMPAIGN_")
    || action.errorCode === "SMS_REGISTRATION_REQUIRED"
    || action.errorCode === "SMS_REGISTRATION_REJECTED") {
    return "SMS is not available for this message.";
  }
  if (action.errorCode === "WORKFLOW_STAFF_INVALID") return "Team member is no longer available.";
  if (action.errorCode === "LEAD_NOT_QUALIFIED") return "Lead is no longer qualified.";
  if (action.errorCode?.startsWith("APPOINTMENT_")) return "Appointment changed before this action ran.";
  if (action.status === "SKIPPED") return "Action was skipped.";
  if (action.status === "FAILED") return "Action could not be completed.";
  if (action.status === "CANCELLED") return "Action was cancelled.";
  return null;
}

export function AutomationBuilder() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [workflow, setWorkflow] = useState<BuilderWorkflow | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [smsReadiness, setSmsReadiness] = useState<SmsReadiness | null>(null);
  const [whatsappTemplates, setWhatsAppTemplates] = useState<WhatsAppTemplate[]>([]);
  const [whatsappNext, setWhatsAppNext] = useState<string | null>(null);
  const [whatsappError, setWhatsAppError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"builder" | "activity">("builder");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [workflowResponse, catalogResponse, teamResponse, smsResponse, whatsappResponse] = await Promise.all([
        fetch(`/api/automations/workflows/${id}`, { cache: "no-store" }),
        fetch("/api/automations/catalog", { cache: "no-store" }),
        fetch("/api/team", { cache: "no-store" }),
        fetch("/api/automations/sms-readiness", { cache: "no-store" }).catch(() => null),
        fetch("/api/automations/whatsapp-templates", { cache: "no-store" }).catch(() => null),
      ]);
      const workflowData = await workflowResponse.json().catch(() => null) as {
        workflow?: BuilderWorkflow;
        canManage?: boolean;
      } | null;
      if (!workflowResponse.ok || !workflowData?.workflow) {
        throw new Error(responseMessage(workflowData, "Unable to load automation."));
      }
      const catalogData = await catalogResponse.json().catch(() => null) as {
        catalog?: Catalog;
      } | null;
      if (!catalogResponse.ok || !catalogData?.catalog) {
        throw new Error(responseMessage(catalogData, "Unable to load automation options."));
      }
      const teamData = await teamResponse.json().catch(() => null) as {
        members?: TeamMember[];
        error?: { message?: string };
      } | null;
      if (!teamResponse.ok) {
        throw new Error(responseMessage(teamData, "Unable to load team members."));
      }

      setWorkflow(workflowData.workflow);
      setName(workflowData.workflow.name);
      setDraft(workflowData.workflow.draft);
      setCatalog(catalogData.catalog);
      const smsData = smsResponse?.ok ? await smsResponse.json().catch(() => null) as { readiness?: SmsReadiness } | null : null;
      setSmsReadiness(smsData?.readiness ?? null);
      const whatsappData = whatsappResponse
        ? await whatsappResponse.json().catch(() => null) as {
            items?: WhatsAppTemplate[]; nextCursor?: string | null; error?: { message?: string };
          } | null
        : null;
      setWhatsAppTemplates(whatsappResponse?.ok ? whatsappData?.items ?? [] : []);
      setWhatsAppNext(whatsappResponse?.ok ? whatsappData?.nextCursor ?? null : null);
      setWhatsAppError(whatsappResponse?.ok ? null
        : whatsappData?.error?.message ?? "WhatsApp templates could not be loaded.");
      setCanManage(Boolean(workflowData.canManage));
      setMembers(teamData?.members ?? []);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automation.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function loadMoreWhatsAppTemplates() {
    if (!whatsappNext) return;
    const response = await fetch(
      `/api/automations/whatsapp-templates?after=${encodeURIComponent(whatsappNext)}`,
      { cache: "no-store" },
    );
    const data = await response.json().catch(() => null) as {
      items?: WhatsAppTemplate[]; nextCursor?: string | null; error?: { message?: string };
    } | null;
    if (!response.ok) {
      setWhatsAppError(data?.error?.message ?? "Unable to load more WhatsApp templates.");
      return;
    }
    setWhatsAppTemplates(current => [...current, ...(data?.items ?? [])]);
    setWhatsAppNext(data?.nextCursor ?? null);
    setWhatsAppError(null);
  }

  const trigger = useMemo(
    () => catalog?.triggers.find(item => item.id === draft?.trigger) ?? null,
    [catalog, draft?.trigger],
  );

  async function loadActivity() {
    if (activityLoaded) return;
    const response = await fetch(`/api/automations/workflows/${id}/activity?limit=100`, { cache: "no-store" });
    const data = await response.json().catch(() => null) as { items?: ActivityItem[] } | null;
    if (response.ok) {
      setActivity(data?.items ?? []);
      setActivityLoaded(true);
    }
  }

  function updateDraft(updater: (current: WorkflowDraft) => WorkflowDraft) {
    setDraft(current => current ? updater(current) : current);
    setDirty(true);
    setTestResult(null);
  }

  function defaultAction(type: Action["type"]): Action {
    const firstMember = members[0]?.userId ?? "";
    if (type === "ASSIGN_LEAD") return { type, userId: firstMember };
    if (type === "NOTIFY_STAFF") {
      return { type, userId: null, title: "New notification", message: "A customer needs attention." };
    }
    if (type === "SEND_CUSTOMER_WHATSAPP") {
      const template = whatsappTemplates[0];
      const count = template ? [...template.body.matchAll(/{{(\d+)}}/g)].length : 0;
      return { type, templateName: template?.name ?? "", languageCode: template?.language ?? "en_US",
        variables: Array.from({ length: count }, () => "name") };
    }
    return { type, message: "Hi {{name}}, thanks for contacting {{business_name}}." };
  }

  function changeTrigger(next: TriggerId) {
    if (!catalog) return;
    const nextCatalog = catalog.triggers.find(item => item.id === next);
    if (!nextCatalog) return;
    updateDraft(current => {
      const conditions = current.conditions.filter(condition =>
        nextCatalog.conditions.includes(condition.field));
      const actions = current.actions.filter(action =>
        nextCatalog.actions.includes(action.type));
      return {
        ...current,
        trigger: next,
        conditions,
        actions: actions.length ? actions : [defaultAction(nextCatalog.actions[0]!)],
      };
    });
  }

  function addCondition() {
    if (!trigger?.conditions.length || !draft || draft.conditions.length >= 10) return;
    const field = trigger.conditions[0];
    updateDraft(current => ({
      ...current,
      conditions: [
        ...current.conditions,
        field === "qualificationScore"
          ? { field, operator: "GTE", value: 80 }
          : { field, operator: "EQ", value: "SMS" },
      ],
    }));
  }

  function changeConditionField(index: number, field: ConditionField) {
    updateDraft(current => ({
      ...current,
      conditions: current.conditions.map((condition, conditionIndex) => {
        if (conditionIndex !== index || condition.field === field) return condition;
        return field === "qualificationScore"
          ? { field, operator: "GTE", value: 80 }
          : { field, operator: "EQ", value: "SMS" };
      }),
    }));
  }

  function updateCondition(index: number, patch: Partial<Condition>) {
    updateDraft(current => ({
      ...current,
      conditions: current.conditions.map((condition, conditionIndex) =>
        conditionIndex === index ? { ...condition, ...patch } as Condition : condition),
    }));
  }

  function removeCondition(index: number) {
    updateDraft(current => ({
      ...current,
      conditions: current.conditions.filter((_condition, conditionIndex) => conditionIndex !== index),
    }));
  }

  function addAction(type: Action["type"]) {
    if (!draft || draft.actions.length >= (catalog?.maxActions ?? 5)) return;
    updateDraft(current => ({ ...current, actions: [...current.actions, defaultAction(type)] }));
  }

  function updateAction(index: number, next: Action) {
    updateDraft(current => ({
      ...current,
      actions: current.actions.map((action, actionIndex) => actionIndex === index ? next : action),
    }));
  }

  function removeAction(index: number) {
    if (!draft || draft.actions.length <= 1) return;
    updateDraft(current => ({
      ...current,
      actions: current.actions.filter((_action, actionIndex) => actionIndex !== index),
    }));
  }

  function moveAction(index: number, direction: -1 | 1) {
    if (!draft) return;
    const target = index + direction;
    if (target < 0 || target >= draft.actions.length) return;
    updateDraft(current => {
      const actions = [...current.actions];
      [actions[index], actions[target]] = [actions[target], actions[index]];
      return { ...current, actions };
    });
  }

  async function saveDraft() {
    if (!draft || !canManage) return null;
    setWorking("save");
    setError(null);
    try {
      const response = await fetch(`/api/automations/workflows/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, draft }),
      });
      const data = await response.json().catch(() => null) as { workflow?: BuilderWorkflow } | null;
      if (!response.ok || !data?.workflow) throw new Error(responseMessage(data, "Unable to save automation."));
      setWorkflow(data.workflow);
      setName(data.workflow.name);
      setDraft(data.workflow.draft);
      setDirty(false);
      return data.workflow;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save automation.");
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function publish() {
    if (!canManage) return;
    const saved = dirty ? await saveDraft() : workflow;
    if (!saved) return;
    setWorking("publish");
    setError(null);
    try {
      const response = await fetch(`/api/automations/workflows/${id}/publish`, { method: "POST" });
      const data = await response.json().catch(() => null) as { workflow?: BuilderWorkflow } | null;
      if (!response.ok || !data?.workflow) throw new Error(responseMessage(data, "Unable to publish automation."));
      setWorkflow(data.workflow);
      setName(data.workflow.name);
      setDraft(data.workflow.draft);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to publish automation.");
    } finally {
      setWorking(null);
    }
  }

  async function resumeLatest() {
    if (!canManage) return;
    const saved = dirty ? await saveDraft() : workflow;
    if (!saved) return;
    const endpoint = saved.hasUnpublishedChanges ? "publish" : "resume";
    setWorking("resume");
    setError(null);
    try {
      const response = await fetch(`/api/automations/workflows/${id}/${endpoint}`, { method: "POST" });
      const data = await response.json().catch(() => null) as { workflow?: BuilderWorkflow } | null;
      if (!response.ok || !data?.workflow) {
        throw new Error(responseMessage(data, "Unable to resume automation."));
      }
      setWorkflow(data.workflow);
      setName(data.workflow.name);
      setDraft(data.workflow.draft);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resume automation.");
    } finally {
      setWorking(null);
    }
  }

  async function archiveAutomation() {
    if (!canManage) return;
    setWorking("archive");
    setError(null);
    try {
      const response = await fetch(`/api/automations/workflows/${id}/archive`, { method: "POST" });
      const data = await response.json().catch(() => null) as { archived?: boolean } | null;
      if (!response.ok || !data?.archived) {
        throw new Error(responseMessage(data, "Unable to archive automation."));
      }
      router.push("/automations");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive automation.");
      setArchiveOpen(false);
    } finally {
      setWorking(null);
    }
  }

  async function changeStatus(action: "pause" | "resume") {
    if (!canManage) return;
    setWorking(action);
    setError(null);
    try {
      const response = await fetch(`/api/automations/workflows/${id}/${action}`, { method: "POST" });
      const data = await response.json().catch(() => null) as { workflow?: BuilderWorkflow } | null;
      if (!response.ok || !data?.workflow) throw new Error(responseMessage(data, "Unable to update automation."));
      setWorkflow(data.workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update automation.");
    } finally {
      setWorking(null);
    }
  }

  async function runTest() {
    setWorking("test");
    setError(null);
    try {
      if (!draft) return;
      const sample: Record<string, unknown> = {};
      if (draft.conditions.some(condition => condition.field === "qualificationScore")) {
        const rawScore = testInputs.qualificationScore ?? "90";
        if (!rawScore.trim()) throw new Error("Enter a qualification score.");
        const score = Number(rawScore);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          throw new Error("Qualification score must be between 0 and 100.");
        }
        sample.qualificationScore = score;
      }
      if (draft.conditions.some(condition => condition.field === "channel")) {
        sample.channel = testInputs.channel || "SMS";
      }
      const response = await fetch(`/api/automations/workflows/${id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, sample }),
      });
      const data = await response.json().catch(() => null) as { result?: TestResult } | null;
      if (!response.ok || !data?.result) throw new Error(responseMessage(data, "Unable to test automation."));
      setTestResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to test automation.");
    } finally {
      setWorking(null);
    }
  }

  if (loading) {
    return <main className="appShell builderShell"><AppNav active="Automations" className="appSidebar" /><section className="builderLoading">Loading automation…</section></main>;
  }
  if (!workflow || !draft || !catalog) {
    return <main className="appShell builderShell"><AppNav active="Automations" className="appSidebar" /><section className="builderLoading">{error ?? "Automation not found."}</section></main>;
  }

  const canAddCondition = Boolean(trigger?.conditions.length) && draft.conditions.length < 10;
  const availableActions = catalog.actions.filter(action => trigger?.actions.includes(action.id)
    && (action.id !== "SEND_CUSTOMER_WHATSAPP" || whatsappTemplates.length > 0));
  const showPublish = workflow.status === "DRAFT"
    || (workflow.status === "ACTIVE" && (dirty || workflow.hasUnpublishedChanges));
  const memberName = (userId?: string | null) =>
    userId ? members.find(member => member.userId === userId)?.name ?? "Team member" : "Everyone";

  return (
    <main className="appShell builderShell">
      <AppNav active="Automations" className="appSidebar builderSidebar" />
      <section className="appWorkspace builderWorkspace">
        <header className="builderTopbar">
          <Link href="/automations">← Back to automations</Link>
          <div className="builderTabs">
            <button className={tab === "builder" ? "active" : ""} onClick={() => setTab("builder")}>Builder</button>
            <button className={tab === "activity" ? "active" : ""} onClick={() => { setTab("activity"); void loadActivity(); }}>Activity</button>
          </div>
        </header>

        {tab === "activity" ? (
          <ActivityView workflow={workflow} items={activity} loading={!activityLoaded} />
        ) : (
          <div className="builderCanvas">
            <div className="builderHeading">
              <input
                className="builderName"
                value={name}
                disabled={!canManage}
                maxLength={120}
                onChange={event => { setName(event.target.value); setDirty(true); }}
                aria-label="Automation name"
              />
              <div className="builderHeadingActions">
                <span className={`builderStatus ${workflow.status.toLowerCase()}`}>{statusLabel(workflow.status)}</span>
                {workflow.status === "ACTIVE" && canManage && (
                  <button className="quietButton" disabled={working !== null} onClick={() => void changeStatus("pause")}>Pause</button>
                )}
                {canManage && <div className="builderMore">
                  <button className="builderMoreButton" aria-label="More automation actions" onClick={() => setMoreOpen(value => !value)}>⋯</button>
                  {moreOpen && <div className="builderMoreMenu">
                    <button onClick={() => { setMoreOpen(false); setArchiveOpen(true); }}>Archive automation</button>
                  </div>}
                </div>}
              </div>
            </div>

            {error && <div className="builderError" role="alert">{error}</div>}

            <section className="builderStep">
              <div className="stepHeader"><span>1</span><h2>WHEN</h2></div>
              <div className="stepBody">
                <select disabled={!canManage} value={draft.trigger} onChange={event => changeTrigger(event.target.value as TriggerId)}>
                  {catalog.triggers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </div>
            </section>

            <section className="builderStep">
              <div className="stepHeader">
                <span>2</span><h2>ONLY IF</h2>
                {draft.conditions.length > 1 && (
                  <fieldset className="conditionMatch" disabled={!canManage} aria-label="Match conditions">
                    <label>
                      <input type="radio" name="condition-match" value="ALL" checked={draft.match === "ALL"}
                        onChange={() => updateDraft(current => ({ ...current, match: "ALL" }))} />
                      <span>All</span>
                    </label>
                    <label>
                      <input type="radio" name="condition-match" value="ANY" checked={draft.match === "ANY"}
                        onChange={() => updateDraft(current => ({ ...current, match: "ANY" }))} />
                      <span>Any</span>
                    </label>
                  </fieldset>
                )}
              </div>
              <div className="stepBody conditionBody">
                {draft.conditions.length === 0 && <span className="alwaysCondition">Always</span>}
                {draft.conditions.map((condition, index) => (
                  <ConditionRow
                    key={`${condition.field}-${index}`}
                    condition={condition}
                    catalog={catalog}
                    fields={trigger?.conditions ?? []}
                    disabled={!canManage}
                    onFieldChange={field => changeConditionField(index, field)}
                    onChange={patch => updateCondition(index, patch)}
                    onRemove={() => removeCondition(index)}
                  />
                ))}
                {canAddCondition && canManage && (
                  <button className="addRowButton" onClick={addCondition}>+ Add condition</button>
                )}
              </div>
            </section>

            <section className="builderStep">
              <div className="stepHeader"><span>3</span><h2>DO</h2><small>{draft.actions.length} of {catalog.maxActions}</small></div>
              <div className="stepBody actionsBody">
                {draft.actions.some(action => action.type === "SEND_CUSTOMER_SMS") && smsReadiness && (
                  <div className={`builderSmsReadiness ${smsReadiness.status === "READY" ? "ready" : "waiting"}`} role="status">
                    <strong>{smsReadiness.status === "READY" ? "SMS sending is ready" : "SMS sending status"}</strong>
                    <span>{smsReadiness.message}</span>
                    {smsReadiness.status !== "READY" && <Link href={smsReadiness.setupUrl}>View SMS setup →</Link>}
                  </div>
                )}
                {draft.actions.some(action => action.type === "SEND_CUSTOMER_WHATSAPP") && (
                  <div className="builderSmsReadiness" role="status">
                    <strong>WhatsApp approved templates</strong>
                    <span>{whatsappTemplates.length
                      ? "Only Meta-approved templates can be selected. Approval and customer consent are rechecked before every send."
                      : whatsappError ?? "No approved text templates available for this account."}</span>
                    <Link href="/integrations/whatsapp/templates">Manage WhatsApp templates →</Link>
                    {whatsappNext && <button type="button" onClick={() => void loadMoreWhatsAppTemplates()}>
                      Load more approved templates</button>}
                  </div>
                )}
                {draft.actions.map((action, index) => (
                  <ActionCard
                    key={index}
                    index={index}
                    action={action}
                    members={members}
                    whatsappTemplates={whatsappTemplates}
                    variables={catalog.variables.filter(variable => trigger?.variables.includes(variable.id))}
                    disabled={!canManage}
                    canRemove={draft.actions.length > 1}
                    onChange={next => updateAction(index, next)}
                    onRemove={() => removeAction(index)}
                    onMove={direction => moveAction(index, direction)}
                  />
                ))}
                {draft.actions.length < catalog.maxActions && canManage && (
                  <label className="addActionSelect">
                    <span>+ Add action</span>
                    <select value="" onChange={event => {
                      if (event.target.value) addAction(event.target.value as Action["type"]);
                    }}>
                      <option value="">Choose action</option>
                      {availableActions.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </section>

            <footer className="builderFooter">
              <button className="secondaryButton" onClick={() => { setTestOpen(true); setTestResult(null); }}>Test automation</button>
              {canManage && <button className="secondaryButton" disabled={!dirty || working !== null} onClick={() => void saveDraft()}>{working === "save" ? "Saving…" : "Save draft"}</button>}
              {canManage && showPublish && <button className="primaryButton" disabled={working !== null || !name.trim()} onClick={() => void publish()}>{working === "publish" ? "Publishing…" : workflow.status === "DRAFT" ? "Publish" : "Publish changes"}</button>}
              {canManage && workflow.status === "PAUSED" && <button className="primaryButton" disabled={working !== null || !name.trim()} onClick={() => void resumeLatest()}>{working === "resume" ? "Resuming…" : "Resume"}</button>}
            </footer>
          </div>
        )}

        {archiveOpen && <div className="archiveBackdrop" onMouseDown={() => working !== "archive" && setArchiveOpen(false)}>
          <div className="archiveDialog" role="dialog" aria-modal="true" aria-label="Archive automation" onMouseDown={event => event.stopPropagation()}>
            <h2>Archive automation?</h2>
            <p>This removes it from your automation list.</p>
            <div>
              <button className="secondaryButton" disabled={working === "archive"} onClick={() => setArchiveOpen(false)}>Cancel</button>
              <button className="dangerButton" disabled={working === "archive"} onClick={() => void archiveAutomation()}>{working === "archive" ? "Archiving…" : "Archive"}</button>
            </div>
          </div>
        </div>}

        {testOpen && (
          <TestPanel
            draft={draft}
            result={testResult}
            inputs={testInputs}
            loading={working === "test"}
            onChange={(key, value) => setTestInputs(current => ({ ...current, [key]: value }))}
            onRun={() => void runTest()}
            onClose={() => setTestOpen(false)}
            memberName={memberName}
          />
        )}
      </section>
    </main>
  );
}

function ConditionRow({
  condition,
  catalog,
  fields,
  disabled,
  onFieldChange,
  onChange,
  onRemove,
}: {
  condition: Condition;
  catalog: Catalog;
  fields: readonly ConditionField[];
  disabled: boolean;
  onFieldChange: (field: ConditionField) => void;
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  const fieldControl = fields.length > 1
    ? <select aria-label="Condition field" disabled={disabled} value={condition.field}
        onChange={event => onFieldChange(event.target.value as ConditionField)}>
        {fields.map(field => <option key={field} value={field}>
          {catalog.conditions[field].label}
        </option>)}
      </select>
    : <span className="conditionField">{catalog.conditions[condition.field].label}</span>;
  if (condition.field === "qualificationScore") {
    const spec = catalog.conditions.qualificationScore;
    return <div className="conditionRow">
      {fieldControl}
      <select disabled={disabled} value={condition.operator} onChange={event => onChange({ operator: event.target.value as Operator })}>
        {spec.operators.map(operator => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
      </select>
      <input disabled={disabled} type="number" min={spec.min} max={spec.max} value={condition.value} onChange={event => onChange({ value: Number(event.target.value) })} />
      {!disabled && <button className="removeButton" onClick={onRemove} aria-label="Remove condition">×</button>}
    </div>;
  }
  const spec = catalog.conditions.channel;
  return <div className="conditionRow">
    {fieldControl}
    <span className="conditionOperator">is</span>
    <select disabled={disabled} value={condition.value} onChange={event => onChange({ value: event.target.value as "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT" })}>
      {spec.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {!disabled && <button className="removeButton" onClick={onRemove} aria-label="Remove condition">×</button>}
  </div>;
}

function ActionCard({
  index,
  action,
  members,
  variables,
  whatsappTemplates,
  disabled,
  canRemove,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  action: Action;
  members: TeamMember[];
  variables: Array<{ id: string; label: string }>;
  whatsappTemplates: WhatsAppTemplate[];
  disabled: boolean;
  canRemove: boolean;
  onChange: (action: Action) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  function insertVariable(variable: string) {
    if (action.type !== "SEND_CUSTOMER_SMS") return;
    const spacer = action.message && !action.message.endsWith(" ") ? " " : "";
    onChange({ ...action, message: `${action.message}${spacer}{{${variable}}}` });
  }

  return <div className="actionCard">
    <div className="actionNumber">{index + 1}</div>
    <div className="actionEditor">
      <div className="actionTitleRow">
        <strong>{actionName(action.type)}</strong>
        {!disabled && <div className="actionTools">
          <button disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move action up">↑</button>
          <button onClick={() => onMove(1)} aria-label="Move action down">↓</button>
          {canRemove && <button onClick={onRemove} aria-label="Remove action">×</button>}
        </div>}
      </div>

      {action.type === "ASSIGN_LEAD" && (
        <select disabled={disabled} value={action.userId} onChange={event => onChange({ ...action, userId: event.target.value })}>
          {members.map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}
        </select>
      )}

      {action.type === "NOTIFY_STAFF" && <>
        <select disabled={disabled} value={action.userId ?? ""} onChange={event => onChange({ ...action, userId: event.target.value || null })}>
          <option value="">Everyone</option>
          {members.map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}
        </select>
        <label><span>Title</span><input disabled={disabled} maxLength={120} value={action.title} onChange={event => onChange({ ...action, title: event.target.value })} /></label>
        <label><span>Message</span><textarea disabled={disabled} maxLength={500} value={action.message} onChange={event => onChange({ ...action, message: event.target.value })} /></label>
      </>}

      {action.type === "SEND_CUSTOMER_WHATSAPP" && <>
        <label><span>Approved template</span>
          <select disabled={disabled} value={`${action.templateName}:${action.languageCode}`}
            onChange={event => {
              const next = whatsappTemplates.find(template =>
                `${template.name}:${template.language}` === event.target.value);
              if (!next) return;
              const count = [...next.body.matchAll(/{{(\d+)}}/g)].length;
              onChange({ ...action, templateName: next.name, languageCode: next.language,
                variables: Array.from({ length: count }, (_value, index) => action.variables[index] ?? variables[0]?.id ?? "name") });
            }}>
            {!whatsappTemplates.some(template =>
              template.name === action.templateName && template.language === action.languageCode)
              && <option value={`${action.templateName}:${action.languageCode}`}>
                {action.templateName || "Select an approved template"} ({action.languageCode})
              </option>}
            {whatsappTemplates.map(template => <option
              key={`${template.name}:${template.language}`}
              value={`${template.name}:${template.language}`}>
              {template.name} · {template.language} · {template.category.toLowerCase()}
            </option>)}
          </select>
        </label>
        {(() => {
          const template = whatsappTemplates.find(item =>
            item.name === action.templateName && item.language === action.languageCode);
          const slots = template ? [...template.body.matchAll(/{{(\d+)}}/g)] : [];
          return <>
            {template && <p>{template.body}</p>}
            {slots.map((_slot, slot) => <label key={slot}>
              <span>Template value {slot + 1}</span>
              <select disabled={disabled} value={action.variables[slot] ?? ""}
                onChange={event => onChange({ ...action,
                  variables: slots.map((_item, index) =>
                    index === slot ? event.target.value : action.variables[index] ?? "") })}>
                <option value="">Choose a value</option>
                {variables.map(variable => <option key={variable.id} value={variable.id}>
                  {variable.label}</option>)}
              </select>
            </label>)}
          </>;
        })()}
      </>}
      {action.type === "SEND_CUSTOMER_SMS" && <>
        <label><span>Message</span><textarea disabled={disabled} maxLength={1600} value={action.message} onChange={event => onChange({ ...action, message: event.target.value })} /></label>
        {!disabled && <div className="variableChips">
          {variables.map(variable => <button key={variable.id} onClick={() => insertVariable(variable.id)}>+ {variable.label}</button>)}
        </div>}
      </>}
    </div>
  </div>;
}

function TestPanel({
  draft,
  result,
  inputs,
  loading,
  onChange,
  onRun,
  onClose,
  memberName,
}: {
  draft: WorkflowDraft;
  result: TestResult | null;
  inputs: Record<string, string>;
  loading: boolean;
  onChange: (key: string, value: string) => void;
  onRun: () => void;
  onClose: () => void;
  memberName: (id?: string | null) => string;
}) {
  return <aside className="testPanel" aria-label="Test automation">
    <div className="testPanelHeader"><h2>Test automation</h2><button onClick={onClose}>×</button></div>
    <div className="testFields">
      {draft.conditions.some(condition => condition.field === "qualificationScore") && <label><span>Qualification score</span><input type="number" min={0} max={100} value={inputs.qualificationScore ?? "90"} onChange={event => onChange("qualificationScore", event.target.value)} /></label>}
      {draft.conditions.some(condition => condition.field === "channel") && <label><span>Channel</span><select value={inputs.channel ?? "SMS"} onChange={event => onChange("channel", event.target.value)}><option value="PHONE">Phone</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option><option value="WEBCHAT">Web chat</option></select></label>}
      <button className="primaryButton" disabled={loading} onClick={onRun}>{loading ? "Testing…" : "Run test"}</button>
    </div>
    {result && <div className={`testResult ${result.matches ? "matched" : "notMatched"}`}>
      <strong>{result.matches ? "Automation would run" : "Automation would not run"}</strong>
      {result.conditions.map((condition, index) => <div className="testCondition" key={index}><span>{condition.matched ? "✓" : "×"}</span>{condition.field} {String(condition.actual ?? "")} {condition.operator} {String(condition.expected ?? "")}</div>)}
      {result.matches && <div className="testActions">
        {result.actions.map((action, index) => <div key={index}><b>{index + 1}</b><span>{action.label}{action.userId !== undefined ? ` · ${memberName(action.userId)}` : ""}</span></div>)}
      </div>}
    </div>}
  </aside>;
}

function ActivityView({
  workflow,
  items,
  loading,
}: {
  workflow: BuilderWorkflow;
  items: ActivityItem[];
  loading: boolean;
}) {
  return <div className="activityView">
    <div className="activityHeading"><h1>{workflow.name}</h1><span className={`builderStatus ${workflow.status.toLowerCase()}`}>{statusLabel(workflow.status)}</span></div>
    {loading && <div className="activityEmpty">Loading activity…</div>}
    {!loading && items.length === 0 && <div className="activityEmpty">No runs yet.</div>}
    {items.map(item => <article className="runCard" key={item.run.id}>
      <div className="runCardHeader">
        <strong className={`runStatus ${item.run.status.toLowerCase()}`}>{runStatus(item.run.status)}</strong>
        <time>{new Date(item.run.createdAt).toLocaleString()}</time>
      </div>
      <div className="runActions">
        {item.actions.map(action => <div key={action.actionIndex} className={`runAction ${action.status.toLowerCase()}`}>
          <span>{["COMPLETED"].includes(action.status) ? "✓" : action.status === "SKIPPED" ? "○" : action.status === "FAILED" || action.status === "UNKNOWN" ? "!" : "·"}</span>
          <div><strong>{actionName(action.actionType)}</strong>{actionOutcome(action) && <small>{actionOutcome(action)}</small>}</div>
        </div>)}
      </div>
      {item.run.status === "FAILED" && <p className="runError">Automation stopped because an action could not be completed.</p>}
    </article>)}
  </div>;
}
