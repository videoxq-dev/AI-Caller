"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { CheckIcon, UsersIcon } from "@/components/icons";

type State = "pending" | "needs-auth" | "success" | "error";

export default function TeamInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<State>("pending");
  const [message, setMessage] = useState("Checking your invitation…");
  const returnTo = useMemo(() => `/team/invite?token=${encodeURIComponent(token ?? "")}`, [token]);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (token === null) return;
    if (!token) {
      setState("error");
      setMessage("This invitation link is incomplete.");
      return;
    }

    fetch("/api/team/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(async (response) => {
      if (cancelled) return;
      if (response.status === 401) {
        setState("needs-auth");
        setMessage("Sign in or create an account with the invited email address to continue.");
        return;
      }
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setState("error");
        setMessage(data?.error?.message ?? "Unable to accept this invitation.");
        return;
      }
      setState("success");
      setMessage("You joined the workspace successfully.");
      window.setTimeout(() => router.replace("/inbox"), 800);
    }).catch(() => {
      if (!cancelled) {
        setState("error");
        setMessage("Unable to accept this invitation.");
      }
    });

    return () => { cancelled = true; };
  }, [router, token]);

  return (
    <AuthShell>
      <div className="authCardContent authCompact">
        <div className="authHeading">
          <span style={{ width: 46, height: 46, display: "grid", placeItems: "center", margin: "0 auto 14px", borderRadius: 14, color: "#1769ee", background: "#e9f3ff" }}>
            {state === "success" ? <CheckIcon size={24} /> : <UsersIcon size={24} />}
          </span>
          <h2>Workspace invitation</h2>
          <p>{message}</p>
        </div>

        {state === "needs-auth" && (
          <div style={{ display: "grid", gap: 10 }}>
            <Link className="primaryButton" href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link>
            <Link className="switchRow" href={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`} style={{ justifyContent: "center" }}>Create account</Link>
          </div>
        )}

        {state === "error" && <div className="switchRow" style={{ justifyContent: "center" }}><Link href="/sign-in">Return to sign in</Link></div>}
        {state === "pending" && <p style={{ margin: 0, textAlign: "center", color: "#6b7c93", fontSize: 13 }}>Please keep this page open.</p>}
      </div>
    </AuthShell>
  );
}
