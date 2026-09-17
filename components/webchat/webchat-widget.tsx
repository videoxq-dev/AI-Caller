"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "./webchat-widget.css";

type WidgetConfig = {
  businessName: string;
  assistantName: string;
  greeting: string;
};

type ChatMessage = {
  id: string;
  role: "customer" | "assistant";
  text: string;
};

type SessionResponse = {
  sessionToken: string;
  visitorId: string;
  history: ChatMessage[];
  widget: WidgetConfig & { publicKey: string; launcherLabel: string };
};

export function WebchatWidget({ widgetKey, config }: { widgetKey: string; config: WidgetConfig }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("AI online");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const storageKeys = useMemo(() => ({
    visitor: `ai-caller:visitor:${widgetKey}`,
    session: `ai-caller:session:${widgetKey}`,
  }), [widgetKey]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      const existingVisitor = window.localStorage.getItem(storageKeys.visitor);
      const existingToken = window.localStorage.getItem(storageKeys.session);
      const visitorId = existingVisitor ?? `visitor_${window.crypto.randomUUID()}`;
      const response = await fetch("/api/widget/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ widgetKey, visitorId, sessionToken: existingToken ?? undefined }),
      });
      if (!response.ok) throw new Error("Unable to start chat.");
      const data = await response.json() as SessionResponse;
      if (cancelled) return;
      window.localStorage.setItem(storageKeys.visitor, data.visitorId);
      window.localStorage.setItem(storageKeys.session, data.sessionToken);
      setSessionToken(data.sessionToken);
      setMessages(data.history.length ? data.history : [{ id: "greeting", role: "assistant", text: data.widget.greeting || config.greeting }]);
      setLoading(false);
    }
    start().catch(() => {
      if (!cancelled) {
        setStatus("Chat unavailable");
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [config.greeting, storageKeys, widgetKey]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function appendAssistantDelta(id: string, delta: string) {
    setMessages((current) => {
      const existing = current.find((message) => message.id === id);
      if (!existing) return [...current, { id, role: "assistant", text: delta }];
      return current.map((message) => message.id === id ? { ...message, text: message.text + delta } : message);
    });
  }

  async function sendMessage() {
    const value = input.trim();
    if (!value || !sessionToken || sending) return;
    const clientMessageId = window.crypto.randomUUID();
    const replyId = `reply_${clientMessageId}`;
    setInput("");
    setSending(true);
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
            const data = JSON.parse(dataLine) as { delta?: string; message?: string; handlingMode?: string };
            if (eventName === "message" && data.delta) appendAssistantDelta(replyId, data.delta);
            if (eventName === "handoff") {
              setStatus("Human handoff");
              if (data.message) appendAssistantDelta(replyId, data.message);
            }
            if (eventName === "error") throw new Error(data.message ?? "Unable to process message.");
            if (eventName === "done" && data.handlingMode !== "HUMAN") setStatus("AI online");
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

      <div className="webchatMessages" ref={scrollerRef} aria-live="polite">
        {loading && <p className="webchatLoading">Starting chat…</p>}
        {messages.map((message) => (
          <div key={message.id} className={`webchatMessage ${message.role}`}><span>{message.text}</span></div>
        ))}
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
