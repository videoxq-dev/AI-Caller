"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageIcon, PhoneIcon, UsersIcon } from "@/components/icons";
import { AppNav } from "./app-nav";

type Channel = "PHONE" | "SMS" | "WHATSAPP" | "WEBCHAT";
type Contact = { id: string; name: string | null; email: string | null; phone: string | null };
type Conversation = { id: string; contactId: string; status: "OPEN" | "CLOSED"; handlingMode: "AI" | "HUMAN"; lastMessageAt: string | null; createdAt: string };
type ConversationRow = { conversation: Conversation; contact: Contact; channels: Channel[] };
type Message = { id: string; channel: Channel; direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; senderType: "CUSTOMER" | "AI" | "USER" | "SYSTEM"; contentType: string; body: string; createdAt: string };
type Timeline = { conversation: Conversation; contact: Contact; messages: Message[] };

const channelLabels: Record<Channel, string> = { PHONE: "Call", SMS: "SMS", WHATSAPP: "WhatsApp", WEBCHAT: "Web Chat" };

function initials(name: string | null) {
  return name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function displayTime(value: string | null) {
  if (!value) return "No messages";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function InboxDataPage() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [channel, setChannel] = useState<"ALL" | Channel>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState("");
  const [sendingReply, setSendingReply] = useState(false);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/conversations?limit=100", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load conversations.");
      const data = await response.json() as { items: ConversationRow[] };
      setRows(data.items);
      if (!selectedId && data.items[0]) setSelectedId(data.items[0].conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load conversations.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  const loadTimeline = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load conversation.");
      const data = await response.json() as { timeline: Timeline };
      setTimeline(data.timeline);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load conversation.");
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setTimeline(null); return; }
    setDraft("");
    void loadTimeline(selectedId);
  }, [loadTimeline, selectedId]);

  const visibleRows = useMemo(() => {
    if (channel === "ALL") return rows;
    return rows.filter((row) => row.channels.includes(channel));
  }, [channel, rows]);

  useEffect(() => {
    if (channel === "ALL") return;
    if (selectedId && visibleRows.some((row) => row.conversation.id === selectedId)) return;
    setSelectedId(visibleRows[0]?.conversation.id ?? null);
  }, [channel, selectedId, visibleRows]);

  async function toggleHandling() {
    if (!timeline) return;
    setSwitching(true);
    setError(null);
    const nextMode = timeline.conversation.handlingMode === "AI" ? "HUMAN" : "AI";
    try {
      const response = await fetch(`/api/conversations/${timeline.conversation.id}/handling`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "Unable to change handling mode.");
      }
      await Promise.all([loadTimeline(timeline.conversation.id), loadConversations()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change handling mode.");
    } finally {
      setSwitching(false);
    }
  }

  const latestChannel = timeline?.messages.at(-1)?.channel ?? "WEBCHAT";
  const canReplyOnWhatsApp = Boolean(timeline && latestChannel === "WHATSAPP" && timeline.conversation.handlingMode === "HUMAN");

  async function sendWhatsAppReply() {
    if (!timeline || !canReplyOnWhatsApp || !draft.trim()) return;
    setSendingReply(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${timeline.conversation.id}/whatsapp-reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft.trim() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "Unable to send WhatsApp reply.");
      }
      setDraft("");
      await Promise.all([loadTimeline(timeline.conversation.id), loadConversations()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send WhatsApp reply.");
    } finally {
      setSendingReply(false);
    }
  }

  return (
    <main className="inboxShell">
      <AppNav active="Inbox" className="appSidebar inboxSidebarNav" />
      <section className="inboxWorkspace">
        <header className="inboxTopbar"><div className="globalSearch"><span>⌕</span><input placeholder="Search conversations, contacts or messages..." readOnly /></div><div className="inboxTopActions"><button type="button" className="agentOnline"><i />AI Agent Online</button></div></header>

        {error && <div style={{ padding: "10px 18px", color: "#b42318" }}>{error}</div>}
        <div className="unifiedInboxGrid">
          <section className="conversationColumn">
            <div className="conversationColumnHeader"><h1>Inbox</h1></div>
            <div className="conversationFilters"><label><select aria-label="Channel filter" value={channel} onChange={(event) => setChannel(event.target.value as "ALL" | Channel)}><option value="ALL">All channels</option><option value="WHATSAPP">WhatsApp</option><option value="SMS">SMS</option><option value="PHONE">Call</option><option value="WEBCHAT">Web Chat</option></select></label></div>
            <div className="conversationList">
              {visibleRows.map(({ conversation, contact, channels }) => (
                <button key={conversation.id} type="button" className={`conversationItem ${selectedId === conversation.id ? "selected" : ""}`} onClick={() => setSelectedId(conversation.id)}>
                  <span className="contactAvatar">{initials(contact.name)}</span>
                  <span className="conversationInfo"><span className="conversationNameRow"><strong>{contact.name ?? "Unnamed contact"}</strong><time>{displayTime(conversation.lastMessageAt)}</time></span><span className="conversationPreview">{contact.phone ?? contact.email ?? "Customer conversation"}</span><span className="conversationTags"><span className={`handlingBadge ${conversation.handlingMode === "HUMAN" ? "human" : "ai"}`}>{conversation.handlingMode === "HUMAN" ? "Human" : "AI handled"}</span>{channels.slice(0, 3).map((item) => <span key={item} className="smallTag">{channelLabels[item]}</span>)}<span className="smallTag">{conversation.status}</span></span></span>
                </button>
              ))}
              {loading && <div style={{ padding: 20 }}>Loading conversations…</div>}
              {!loading && !visibleRows.length && <div style={{ padding: 20 }}>{rows.length ? "No conversations match this channel." : "No conversations yet. Web chat, SMS, WhatsApp and voice channels will create conversations here."}</div>}
            </div>
          </section>

          <section className="threadColumn">
            {timeline ? <>
              <header className="threadHeader"><div className="threadContact"><span className="threadAvatar">{initials(timeline.contact.name)}</span><div><strong>{timeline.contact.name ?? "Unnamed contact"}</strong><span>{timeline.contact.phone ?? timeline.contact.email ?? "No contact details"}</span></div></div><div className="threadActions"><button className={`takeoverTop ${timeline.conversation.handlingMode === "HUMAN" ? "active" : ""}`} type="button" disabled={switching} onClick={() => void toggleHandling()}>{timeline.conversation.handlingMode === "HUMAN" ? "Return to AI" : "Human takeover"}</button></div></header>
              <div className="threadBody">
                {!timeline.messages.length && <div className="dayDivider"><span>No messages yet</span></div>}
                {timeline.messages.map((message) => {
                  const customer = message.senderType === "CUSTOMER";
                  return <div key={message.id} className={`messageRow ${customer ? "customer" : "agent"}`}>{customer && <span className="miniAvatar">{initials(timeline.contact.name)}</span>}<div className={`messageBubble ${customer ? "incoming" : "outgoing"}`}><div className="messageMeta"><span className={`channelBadge ${channelLabels[message.channel].toLowerCase().replace(" ", "-")}`}>{message.channel === "PHONE" ? <PhoneIcon size={13} /> : <MessageIcon size={13} />}{channelLabels[message.channel]}</span><time>{displayTime(message.createdAt)}</time></div><p>{message.body}</p></div>{!customer && <span className="botAvatar">{message.senderType === "USER" ? <UsersIcon size={16} /> : "✦"}</span>}</div>;
                })}
              </div>
              <div className="composerWrap"><div className="composerTabs"><button className="active" type="button">Message</button></div><textarea aria-label="Conversation reply" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!canReplyOnWhatsApp || sendingReply} placeholder={canReplyOnWhatsApp ? "Reply on WhatsApp…" : latestChannel === "WHATSAPP" ? "Take over this conversation to reply on WhatsApp." : `Staff outbound ${channelLabels[latestChannel]} replies are not enabled yet.`} /><div className="composerFooter"><span>{canReplyOnWhatsApp ? "Free-form WhatsApp replies require an active 24-hour customer window." : "WhatsApp staff replies are available after human takeover."}</span>{canReplyOnWhatsApp && <button className="sendButton" type="button" disabled={sendingReply || !draft.trim()} onClick={() => void sendWhatsAppReply()}>{sendingReply ? "Sending…" : "Send"}</button>}</div></div>
            </> : <div style={{ display: "grid", placeItems: "center", height: "100%", minHeight: 420 }}>Select a conversation to view its timeline.</div>}
          </section>

          <aside className="contactColumn">
            {timeline ? <><div className="contactTabs"><button className="active" type="button">Contact</button></div><section className="contactSummary"><span className="largeAvatar">{initials(timeline.contact.name)}</span><div><strong>{timeline.contact.name ?? "Unnamed contact"}</strong><span>{timeline.contact.phone ?? "No phone"}</span><span>{timeline.contact.email ?? "No email"}</span></div></section><div className="contactChannelRow"><span className={`channelBadge ${channelLabels[latestChannel].toLowerCase().replace(" ", "-")}`}>{channelLabels[latestChannel]}</span><span className="currentChannel">Latest channel</span></div><section className="detailSection"><div className="detailHeading"><strong>Conversation state</strong></div><div className="infoRows compact"><div><span>Handling</span><strong>{timeline.conversation.handlingMode}</strong></div><div><span>Status</span><strong>{timeline.conversation.status}</strong></div><div><span>Messages</span><strong>{timeline.messages.length}</strong></div></div></section></> : null}
          </aside>
        </div>
      </section>
    </main>
  );
}
