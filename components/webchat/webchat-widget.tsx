"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "./webchat-widget.css";

type WidgetConfig = {
  businessName: string;
  assistantName: string;
  greeting: string;
  smsTermsUrl?: string | null;
  marketingProgramApproved?: boolean;
};

type BookingCard = {
  draftId: string;
  previewId: string;
  version: number;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
  requiredLocation: string | null;
  expiresAt: string;
  status: "AWAITING_CONFIRMATION" | "STALE" | "CONFIRMED";
};

type ChatMessage = {
  id: string;
  role: "customer" | "assistant";
  text: string;
  booking?: BookingCard;
};

type SessionResponse = {
  sessionToken: string;
  history: ChatMessage[];
  widget: WidgetConfig & { publicKey: string; launcherLabel: string };
};

export function WebchatWidget({ widgetKey, config }: { widgetKey: string; config: WidgetConfig }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [captured, setCaptured] = useState(false);
  const [profile, setProfile] = useState({ name: "", email: "", phone: "", transactionalSmsConsent: false, marketingSmsConsent: false });
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState("");
  const [termsUrl, setTermsUrl] = useState<string | null>(null);
  const [marketingAllowed, setMarketingAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [assistantTyping, setAssistantTyping] = useState(false);
  const [confirmingPreview, setConfirmingPreview] = useState<string | null>(null);
  const [status, setStatus] = useState("AI online");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sessionStorageKey = useMemo(() => `ai-caller:session:${widgetKey}`, [widgetKey]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      const existingToken = window.localStorage.getItem(sessionStorageKey);
      const response = await fetch("/api/widget/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ widgetKey, sessionToken: existingToken ?? undefined }),
      });
      if (!response.ok) throw new Error("Unable to start chat.");
      const data = await response.json() as SessionResponse;
      if (cancelled) return;
      window.localStorage.setItem(sessionStorageKey, data.sessionToken);
      setSessionToken(data.sessionToken);
      setTermsUrl(data.widget.smsTermsUrl ?? null);
      setMarketingAllowed(data.widget.marketingProgramApproved === true);
      void fetch("/api/widget/contact", { headers: { authorization: "Bearer " + data.sessionToken }, cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((details) => {
          if (cancelled || !details) return;
          setCaptured(Boolean(details.captured));
          setProfile((current) => ({ ...current, name: details.name ?? "", email: details.email ?? "", phone: details.phone ?? "" }));
        }).catch(() => undefined);
      setMessages(data.history.length ? data.history : [{ id: "greeting", role: "assistant", text: data.widget.greeting || config.greeting }]);
      setLoading(false);
    }
    start().catch(() => {
      if (!cancelled) {
        window.localStorage.removeItem(sessionStorageKey);
        setStatus("Chat unavailable");
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [config.greeting, sessionStorageKey, widgetKey]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, assistantTyping]);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;

    const refresh = async () => {
      if (sending) return;
      const response = await fetch("/api/widget/history", {
        headers: { authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json() as { history?: ChatMessage[] };
      if (cancelled || !data.history?.length) return;
      // Provider history does not contain transient service notices (e.g. a
      // PAUSED agent did not generate an AI message). Keep those notices
      // visible when the four-second polling refresh replaces server history.
      setMessages((current) => [
        ...data.history!,
        ...current.filter((message) => message.id.startsWith("notice_")).slice(-8),
      ]);
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sending, sessionToken]);

  async function submitProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken || contactSaving) return;
    setContactSaving(true);
    setContactError("");
    try {
      const response = await fetch("/api/widget/contact", {
        method: "POST",
        headers: { authorization: "Bearer " + sessionToken, "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to save your contact details.");
      setCaptured(true);
    } catch (error) {
      setContactError(error instanceof Error ? error.message : "Unable to save your contact details.");
    } finally { setContactSaving(false); }
  }

  function appendAssistantDelta(id: string, delta: string) {
    setAssistantTyping(false);
    setMessages((current) => {
      const existing = current.find((message) => message.id === id);
      if (!existing) return [...current, { id, role: "assistant", text: delta }];
      return current.map((message) => message.id === id ? { ...message, text: message.text + delta } : message);
    });
  }


  async function confirmBooking(card: BookingCard) {
    if (!sessionToken || confirmingPreview || card.status !== "AWAITING_CONFIRMATION" ||
      new Date(card.expiresAt).getTime() <= Date.now()) return;
    const eventId = window.crypto.randomUUID();
    setConfirmingPreview(card.previewId);
    setMessages((current) => [...current, { id: eventId, role: "customer", text: "Confirm appointment" }]);
    try {
      const response = await fetch("/api/widget/bookings/confirm", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sessionToken, "content-type": "application/json",
        },
        body: JSON.stringify({
          draftId: card.draftId, previewId: card.previewId,
          expectedVersion: card.version, clientEventId: eventId,
        }),
      });
      const result = await response.json() as {
        reply?: string; status?: string; bookingCard?: BookingCard;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(result.error?.message ?? "Unable to confirm appointment.");
      setMessages((current) => [
        ...current.map((message) => message.booking?.previewId === card.previewId
          ? { ...message, booking: result.bookingCard ?? message.booking } : message),
        { id: "booking_reply_" + eventId, role: "assistant", text: result.reply ??
          "Your booking is being verified." },
      ]);
    } catch (error) {
      setMessages((current) => [...current, {
        id: "notice_booking_" + eventId, role: "assistant",
        text: error instanceof Error ? error.message : "Unable to confirm appointment.",
      }]);
    } finally { setConfirmingPreview(null); }
  }

  async function sendMessage() {
    const value = input.trim();
    if (!value || !sessionToken || sending) return;
    const clientMessageId = window.crypto.randomUUID();
    const replyId = `reply_${clientMessageId}`;
    setInput("");
    setSending(true);
    setAssistantTyping(true);
    setStatus("Thinking…");
    setMessages((current) => [...current, { id: clientMessageId, role: "customer", text: value }]);

    try {
      const response = await fetch("/api/widget/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientMessageId, message: value }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "Unable to send message.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n");
          const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (eventName && dataLine) {
            const data = JSON.parse(dataLine) as { delta?: string; message?: string;
              handlingMode?: string; agentAvailable?: boolean; previewId?: string;
              draftId?: string; version?: number; serviceName?: string;
              startsAt?: string; endsAt?: string; timezone?: string;
              durationMinutes?: number; requiredLocation?: string | null;
              expiresAt?: string; status?: BookingCard["status"] };
            if (eventName === "message" && data.delta) appendAssistantDelta(replyId, data.delta);
            if (eventName === "booking" && data.previewId && data.draftId) {
              const booking = data as BookingCard;
              setMessages((current) => current.map((message) =>
                message.id === replyId ? { ...message, booking } : message));
            }
            if (eventName === "handoff") {
              setAssistantTyping(false);
              setStatus("Human handoff");
              if (data.message) appendAssistantDelta(replyId, data.message);
            }
            if (eventName === "unavailable" || eventName === "notice") {
              setAssistantTyping(false);
              setStatus(eventName === "unavailable" ? "AI unavailable" : "No AI reply");
              if (data.message) appendAssistantDelta(`notice_${clientMessageId}`, data.message);
            }
            if (eventName === "error") {
              setAssistantTyping(false);
              throw new Error(data.message ?? "Unable to process message.");
            }
            if (eventName === "done") {
              setAssistantTyping(false);
              if (data.agentAvailable !== false && data.handlingMode === "AI") setStatus("AI online");
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send message.";
      appendAssistantDelta(replyId, `Sorry, ${message}`);
      setStatus("Try again");
    } finally {
      setSending(false);
      setAssistantTyping(false);
      setStatus((current) => current === "Thinking…" ? "AI online" : current);
    }
  }

  return (
    <main className="webchatShell">
      <header className="webchatHeader">
        <div className="webchatAvatar">AI</div>
        <div><strong>{config.assistantName}</strong><span>{config.businessName} · {status}</span></div>
        <button type="button" aria-label="Close chat" onClick={() => window.parent.postMessage({ type: "ai-caller-close" }, "*")}>×</button>
      </header>

      {!loading && sessionToken && !captured && <form className="webchatContactForm" onSubmit={(event) => void submitProfile(event)}>
        <strong>Stay connected</strong>
        <label>Name<input required maxLength={200} autoComplete="name" value={profile.name} onChange={(event) => setProfile((p) => ({ ...p, name: event.target.value }))} /></label>
        <label>Email<input required type="email" autoComplete="email" value={profile.email} onChange={(event) => setProfile((p) => ({ ...p, email: event.target.value }))} /></label>
        <label>Phone<input required type="tel" autoComplete="tel" value={profile.phone} onChange={(event) => setProfile((p) => ({ ...p, phone: event.target.value }))} /></label>
        {termsUrl && <><label className="webchatConsentChoice"><input type="checkbox" checked={profile.transactionalSmsConsent} onChange={(event) => setProfile((p) => ({ ...p, transactionalSmsConsent: event.target.checked }))} />
          I agree to receive appointment confirmations, reminders, and related SMS updates from {config.businessName}.
        </label>
        {marketingAllowed && <label className="webchatConsentChoice"><input type="checkbox" checked={profile.marketingSmsConsent} onChange={(event) => setProfile((p) => ({ ...p, marketingSmsConsent: event.target.checked }))} />
          I separately agree to receive promotional SMS messages and offers from {config.businessName}.
        </label>}
        <small>Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. <a href={termsUrl} target="_blank" rel="noopener noreferrer">Our SMS Terms &amp; Policy</a></small></>}
        {contactError && <p role="alert">{contactError}</p>}
        <button type="submit" disabled={contactSaving}>{contactSaving ? "Saving…" : "Save contact details"}</button>
      </form>}
      <div className="webchatMessages" ref={scrollerRef} aria-live="polite">
        {loading && <p className="webchatLoading">Starting chat…</p>}
        {messages.map((message) => (
          <div key={message.id} className={`webchatMessage ${message.role} ${message.booking ? "withBooking" : ""}`}>
            <span>{message.text}</span>
            {message.booking && <section className="webchatBookingCard" aria-label="Appointment confirmation">
              <strong>{message.booking.serviceName}</strong>
              <div>{new Intl.DateTimeFormat("en-US", {
                dateStyle: "full", timeStyle: "short", timeZone: message.booking.timezone,
              }).format(new Date(message.booking.startsAt))}</div>
              <div>Ends {new Intl.DateTimeFormat("en-US", {
                timeStyle: "short", timeZone: message.booking.timezone,
              }).format(new Date(message.booking.endsAt))} ({message.booking.timezone})</div>
              <small>{message.booking.durationMinutes} minutes
                {message.booking.requiredLocation ? " · " + message.booking.requiredLocation : ""}</small>
              <div className="webchatBookingActions">
                {message.booking.status === "CONFIRMED" ? <strong>Confirmed</strong> :
                  message.booking.status === "STALE" ||
                    new Date(message.booking.expiresAt).getTime() <= Date.now() ||
                    messages.some((other) => other.booking?.draftId === message.booking?.draftId &&
                      other.booking.previewId !== message.booking.previewId &&
                      other.booking.version > message.booking.version)
                    ? <small>Preview expired or replaced</small> : <>
                      <button type="button" disabled={Boolean(confirmingPreview || sending)}
                        onClick={() => void confirmBooking(message.booking!)}>Confirm appointment</button>
                      <button type="button" className="secondary" disabled={Boolean(confirmingPreview)}
                        onClick={() => setInput("Change the appointment to ")}>Change</button>
                    </>}
              </div>
            </section>}
          </div>
        ))}
        {assistantTyping && <div className="webchatMessage assistant webchatTyping" aria-label="AI is typing" role="status">
          <span aria-hidden="true"><i /><i /><i /></span>
        </div>}
      </div>

      <div className="webchatComposer">
        <textarea
          rows={1}
          value={input}
          disabled={loading || !sessionToken}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
          placeholder="Type your message…"
        />
        <button type="button" disabled={!input.trim() || sending || !sessionToken} onClick={() => void sendMessage()} aria-label="Send message">↑</button>
      </div>
      <footer>Powered by AI Caller</footer>
    </main>
  );
}
