"use client";

import { useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "info";
type ToastItem = { id: number; message: string; tone: ToastTone };

const TOAST_EVENT = "ai-caller:toast";

export function showToast(message: string, tone: ToastTone = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent<{ message?: unknown; tone?: unknown }>).detail;
      if (!detail || typeof detail.message !== "string" || !detail.message.trim()) return;
      const message = detail.message.trim();
      const tone: ToastTone = detail.tone === "success" || detail.tone === "error" ? detail.tone : "info";
      const id = nextId.current++;
      setItems((current) => [...current.slice(-2), { id, message, tone }]);
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 5000);
    }

    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (!items.length) return null;

  return (
    <div className="toastViewport" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div className={`appToast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"} key={item.id}>
          <span className="toastMarker" aria-hidden="true">{item.tone === "success" ? "✓" : item.tone === "error" ? "!" : "i"}</span>
          <span>{item.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setItems((current) => current.filter((currentItem) => currentItem.id !== item.id))}>×</button>
        </div>
      ))}
    </div>
  );
}
