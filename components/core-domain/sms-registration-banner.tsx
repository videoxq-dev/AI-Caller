"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import "./sms-registration-banner.css";

type NumberInfo = { status: string; messagingReadiness: "NOT_REGISTERED" | "PENDING" | "REJECTED" | "READY" };
export function SmsRegistrationBanner() {
  const [number, setNumber] = useState<NumberInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/phone-numbers", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled) setNumber(data?.number ?? null); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  if (!number || !["ACTIVE", "PAST_DUE"].includes(number.status) || number.messagingReadiness === "READY") return null;
  const rejected = number.messagingReadiness === "REJECTED";
  const pending = number.messagingReadiness === "PENDING";
  return <div className="smsRegistrationBanner" role="status">
    <span><strong>{rejected ? "SMS registration needs attention" : pending ? "SMS registration pending" : "Activate SMS messaging"}</strong>
      {" "}{rejected ? "Review the carrier response and correct your registration." : pending ? "Your number remains available for calls while your carrier reviews the registration." : "Your number is ready for calls. Register anytime to enable outbound SMS."}</span>
    <Link href="/settings?tab=phone#sms-registration">{rejected ? "Review registration" : pending ? "View status" : "Set up SMS"} →</Link>
  </div>;
}