"use client";

import { useState } from "react";
import "./knowledge-editor.css";

type ServiceRow = { id: string; name: string; description: string | null; priceText: string | null; durationMinutes: number | null; active: boolean };
type FAQRow = { id: string; question: string; answer: string; active: boolean };
type PolicyRow = { id: string; type: string; title: string; content: string };

type EditorKind = "service" | "faq" | "policy";

export function KnowledgeEditor({ initialServices, initialFaqs, initialPolicies }: { initialServices: ServiceRow[]; initialFaqs: FAQRow[]; initialPolicies: PolicyRow[] }) {
  const [services, setServices] = useState(initialServices);
  const [faqs, setFaqs] = useState(initialFaqs);
  const [policies, setPolicies] = useState(initialPolicies);
  const [editing, setEditing] = useState<{ kind: EditorKind; id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.message ?? "Unable to save changes.");
    return payload;
  }

  async function remove(kind: EditorKind, id: string) {
    if (!window.confirm("Delete this item?")) return;
    setError(null);
    try {
      const base = kind === "service" ? "services" : kind === "faq" ? "faqs" : "policies";
      await request(`/api/agent/${base}/${id}`, "DELETE");
      if (kind === "service") setServices((rows) => rows.filter((row) => row.id !== id));
      if (kind === "faq") setFaqs((rows) => rows.filter((row) => row.id !== id));
      if (kind === "policy") setPolicies((rows) => rows.filter((row) => row.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete item.");
    }
  }

  return (
    <div className="knowledgeEditor">
      {error && <div className="knowledgeError">{error}</div>}

      <KnowledgeSection title="Services" addLabel="Add service" onAdd={() => setEditing({ kind: "service" })}>
        {services.length ? services.map((service) => (
          <article className="knowledgeItem" key={service.id}>
            <div><strong>{service.name}</strong><span>{service.priceText || "No price set"}{service.durationMinutes ? ` • ${service.durationMinutes} min` : ""}</span>{service.description && <p>{service.description}</p>}</div>
            <div className="knowledgeItemActions"><button type="button" onClick={() => setEditing({ kind: "service", id: service.id })}>Edit</button><button type="button" onClick={() => remove("service", service.id)}>Delete</button></div>
          </article>
        )) : <EmptyText>Add the services your AI can discuss and book.</EmptyText>}
      </KnowledgeSection>

      <KnowledgeSection title="Frequently asked questions" addLabel="Add FAQ" onAdd={() => setEditing({ kind: "faq" })}>
        {faqs.length ? faqs.map((faq) => (
          <article className="knowledgeItem" key={faq.id}>
            <div><strong>{faq.question}</strong><p>{faq.answer}</p></div>
            <div className="knowledgeItemActions"><button type="button" onClick={() => setEditing({ kind: "faq", id: faq.id })}>Edit</button><button type="button" onClick={() => remove("faq", faq.id)}>Delete</button></div>
          </article>
        )) : <EmptyText>Add approved answers to common customer questions.</EmptyText>}
      </KnowledgeSection>

      <KnowledgeSection title="Policies" addLabel="Add policy" onAdd={() => setEditing({ kind: "policy" })}>
        {policies.length ? policies.map((policy) => (
          <article className="knowledgeItem" key={policy.id}>
            <div><strong>{policy.title}</strong><span>{policy.type}</span><p>{policy.content}</p></div>
            <div className="knowledgeItemActions"><button type="button" onClick={() => setEditing({ kind: "policy", id: policy.id })}>Edit</button><button type="button" onClick={() => remove("policy", policy.id)}>Delete</button></div>
          </article>
        )) : <EmptyText>Add cancellation, pricing, refund, service-area or escalation policies.</EmptyText>}
      </KnowledgeSection>

      {editing?.kind === "service" && <ServiceEditor row={services.find((row) => row.id === editing.id)} onClose={() => setEditing(null)} onSaved={(row) => { setServices((rows) => editing.id ? rows.map((item) => item.id === row.id ? row : item) : [...rows, row]); setEditing(null); }} onError={setError} request={request} />}
      {editing?.kind === "faq" && <FAQEditor row={faqs.find((row) => row.id === editing.id)} onClose={() => setEditing(null)} onSaved={(row) => { setFaqs((rows) => editing.id ? rows.map((item) => item.id === row.id ? row : item) : [...rows, row]); setEditing(null); }} onError={setError} request={request} />}
      {editing?.kind === "policy" && <PolicyEditor row={policies.find((row) => row.id === editing.id)} onClose={() => setEditing(null)} onSaved={(row) => { setPolicies((rows) => editing.id ? rows.map((item) => item.id === row.id ? row : item) : [...rows, row]); setEditing(null); }} onError={setError} request={request} />}
    </div>
  );
}

function KnowledgeSection({ title, addLabel, onAdd, children }: { title: string; addLabel: string; onAdd: () => void; children: React.ReactNode }) {
  return <section className="knowledgeEditorSection"><div className="knowledgeEditorHeading"><strong>{title}</strong><button type="button" onClick={onAdd}>+ {addLabel}</button></div><div className="knowledgeEditorList">{children}</div></section>;
}

function EmptyText({ children }: { children: React.ReactNode }) { return <div className="knowledgeEmpty">{children}</div>; }

type RequestFn = (url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => Promise<any>;

type CommonEditorProps<T> = { row?: T; onClose: () => void; onSaved: (row: T) => void; onError: (message: string) => void; request: RequestFn };

function ServiceEditor({ row, onClose, onSaved, onError, request }: CommonEditorProps<ServiceRow>) {
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [priceText, setPriceText] = useState(row?.priceText ?? "");
  const [duration, setDuration] = useState(row?.durationMinutes?.toString() ?? "");
  return <EditorShell title={row ? "Edit service" : "Add service"} onClose={onClose} onSave={async () => { try { const payload = await request(row ? `/api/agent/services/${row.id}` : "/api/agent/services", row ? "PATCH" : "POST", { name, description: description || null, priceText: priceText || null, durationMinutes: duration ? Number(duration) : null, active: true }); onSaved(payload.service); } catch (reason) { onError(reason instanceof Error ? reason.message : "Unable to save service."); } }}><label><span>Service name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Description</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label><div className="editorTwoCol"><label><span>Price</span><input value={priceText} onChange={(event) => setPriceText(event.target.value)} placeholder="$99 or From $99" /></label><label><span>Duration (minutes)</span><input type="number" min={1} value={duration} onChange={(event) => setDuration(event.target.value)} /></label></div></EditorShell>;
}

function FAQEditor({ row, onClose, onSaved, onError, request }: CommonEditorProps<FAQRow>) {
  const [question, setQuestion] = useState(row?.question ?? "");
  const [answer, setAnswer] = useState(row?.answer ?? "");
  return <EditorShell title={row ? "Edit FAQ" : "Add FAQ"} onClose={onClose} onSave={async () => { try { const payload = await request(row ? `/api/agent/faqs/${row.id}` : "/api/agent/faqs", row ? "PATCH" : "POST", { question, answer, active: true }); onSaved(payload.faq); } catch (reason) { onError(reason instanceof Error ? reason.message : "Unable to save FAQ."); } }}><label><span>Question</span><input value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label><span>Approved answer</span><textarea rows={5} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label></EditorShell>;
}

function PolicyEditor({ row, onClose, onSaved, onError, request }: CommonEditorProps<PolicyRow>) {
  const [type, setType] = useState(row?.type ?? "General");
  const [title, setTitle] = useState(row?.title ?? "");
  const [content, setContent] = useState(row?.content ?? "");
  return <EditorShell title={row ? "Edit policy" : "Add policy"} onClose={onClose} onSave={async () => { try { const payload = await request(row ? `/api/agent/policies/${row.id}` : "/api/agent/policies", row ? "PATCH" : "POST", { type, title, content }); onSaved(payload.policy); } catch (reason) { onError(reason instanceof Error ? reason.message : "Unable to save policy."); } }}><div className="editorTwoCol"><label><span>Policy type</span><select value={type} onChange={(event) => setType(event.target.value)}><option>General</option><option>Pricing</option><option>Cancellation</option><option>Refund</option><option>Service area</option><option>Escalation</option></select></label><label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label></div><label><span>Policy</span><textarea rows={6} value={content} onChange={(event) => setContent(event.target.value)} /></label></EditorShell>;
}

function EditorShell({ title, onClose, onSave, children }: { title: string; onClose: () => void; onSave: () => Promise<void>; children: React.ReactNode }) {
  const [saving, setSaving] = useState(false);
  return <div className="knowledgeModalBackdrop" role="presentation"><section className="knowledgeModal" role="dialog" aria-modal="true" aria-label={title}><div className="knowledgeModalHeading"><h3>{title}</h3><button type="button" onClick={onClose}>×</button></div><div className="knowledgeModalFields">{children}</div><div className="knowledgeModalActions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={saving} onClick={async () => { setSaving(true); try { await onSave(); } finally { setSaving(false); } }}>{saving ? "Saving..." : "Save"}</button></div></section></div>;
}
