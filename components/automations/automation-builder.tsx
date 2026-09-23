"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
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
  | { type: "SEND_CUSTOMER_SMS"; message: string };
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

export function AutomationBuilder() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [workflow, setWorkflow] = useState<BuilderWorkflow | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"builder" | "activity">("builder");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [workflowResponse, catalogResponse, teamResponse] = await Promise.all([
        fetch(`/api/automations/workflows/${id}`, { cache: "no-store" }),
        fetch("/api/automations/catalog", { cache: "no-store" }),
        fetch("/api/team", { cache: "no-store" }),
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
      const teamData = await teamResponse.json().catch(() => null) as { members?: TeamMember[] } | null;

      setWorkflow(workflowData.workflow);
      setName(workflowData.workflow.name);
      setDraft(workflowData.workflow.draft);
      setCatalog(catalogData.catalog);
      setCanManage(Boolean(workflowData.canManage));
      setMembers(teamResponse.ok ? teamData?.members ?? [] : []);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automation.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

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
        actions: actions.length ? actions : [defaultAction(nextCatalog.actions[0])],
      };
    });
  }

  function addCondition() {
    if (!trigger || !catalog) return;
    const available = trigger.conditions.find(field =>
      !draft?.conditions.some(condition => condition.field === field));
    if (!available) return;
    updateDraft(current => ({
      ...current,
      conditions: [
        ...current.conditions,
        available === "qualificationScore"
          ? { field: available, operator: "GTE", value: 80 }
          : { field: available, operator: "EQ", value: "SMS" },
      ],
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
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) return;
      }
      const body: Record<string, unknown> = {};
      if (draft?.conditions.some(condition => condition.field === "qualificationScore")) {
        body.qualificationScore = Number(testInputs.qualificationScore ?? "0");
      }
      if (draft?.conditions.some(condition => condition.field === "channel")) {
        body.channel = testInputs.channel || "SMS";
      }
      const response = await fetch(`/api/automations/workflows/${id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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

  const availableConditions = trigger?.conditions.filter(field =>
    !draft.conditions.some(condition => condition.field === field)) ?? [];
  const availableActions = catalog.actions.filter(action => trigger?.actions.includes(action.id));
  const showPublish = workflow.status === "DRAFT" || dirty || workflow.hasUnpublishedChanges;
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
                {workflow.status === "PAUSED" && canManage && !showPublish && (
                  <button className="quietButton" disabled={working !== null} onClick={() => void changeStatus("resume")}>Resume</button>
                )}
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
                  <select className="matchSelect" disabled={!canManage} value={draft.match} onChange={event => updateDraft(current => ({ ...current, match: event.target.value as "ALL" | "ANY" }))}>
                    <option value="ALL">All are true</option>
                    <option value="ANY">Any are true</option>
                  </select>
                )}
              </div>
              <div className="stepBody conditionBody">
                {draft.conditions.length === 0 && <span className="alwaysCondition">Always</span>}
                {draft.conditions.map((condition, index) => (
                  <ConditionRow
                    key={`${condition.field}-${index}`}
                    condition={condition}
                    catalog={catalog}
                    disabled={!canManage}
                    onChange={patch => updateCondition(index, patch)}
                    onRemove={() => removeCondition(index)}
                  />
                ))}
                {availableConditions.length > 0 && canManage && (
                  <button className="addRowButton" onClick={addCondition}>+ Add condition</button>
                )}
              </div>
            </section>

            <section className="builderStep">
              <div className="stepHeader"><span>3</span><h2>DO</h2><small>{draft.actions.length} of {catalog.maxActions}</small></div>
              <div className="stepBody actionsBody">
                {draft.actions.map((action, index) => (
                  <ActionCard
                    key={index}
                    index={index}
                    action={action}
                    members={members}
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
              {canManage && workflow.status === "PAUSED" && !showPublish && <button className="primaryButton" disabled={working !== null} onClick={() => void changeStatus("resume")}>Resume</button>}
            </footer>
          </div>
        )}

        {testOpen && (
          <TestPanel
            draft={draft}
            result={testResult}
            inputs={testInputs}
            members={members}
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
  disabled,
  onChange,
  onRemove,
}: {
  condition: Condition;
  catalog: Catalog;
  disabled: boolean;
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  if (condition.field === "qualificationScore") {
    const spec = catalog.conditions.qualificationScore;
    return <div className="conditionRow">
      <span className="conditionField">{spec.label}</span>
      <select disabled={disabled} value={condition.operator} onChange={event => onChange({ operator: event.target.value as Operator })}>
        {spec.operators.map(operator => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
      </select>
      <input disabled={disabled} type="number" min={spec.min} max={spec.max} value={condition.value} onChange={event => onChange({ value: Number(event.target.value) })} />
      {!disabled && <button className="removeButton" onClick={onRemove} aria-label="Remove condition">×</button>}
    </div>;
  }
  const spec = catalog.conditions.channel;
  return <div className="conditionRow">
    <span className="conditionField">{spec.label}</span>
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

      {action.type === "SEND_CUSTOMER_SMS" && <>
        <label><span>Message</span><textarea disabled={disabled} maxLength={2000} value={action.message} onChange={event => onChange({ ...action, message: event.target.value })} /></label>
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
      {result.conditions.map((condition, index) => <div className="testCondition" key={index}><span>{condition.matched ? "✓" : "×"}</span>{condition.field} {condition.actual} {condition.operator} {condition.expected}</div>)}
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
          <div><strong>{actionName(action.actionType)}</strong>{action.errorMessage && <small>{action.errorMessage}</small>}</div>
        </div>)}
      </div>
      {item.run.errorMessage && <p className="runError">{item.run.errorMessage}</p>}
    </article>)}
  </div>;
}
