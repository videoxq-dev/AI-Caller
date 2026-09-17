"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon } from "@/components/icons";
import { PasswordField } from "@/components/password-field";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/forgot-password`,
    });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Unable to send a reset link.");
      return;
    }

    setMessage("If an account exists for that email, a reset link has been sent.");
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;

    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      setPending(false);
      return;
    }

    const result = await authClient.resetPassword({ newPassword, token });
    if (result.error) {
      setError(result.error.message ?? "Unable to reset your password.");
      setPending(false);
      return;
    }

    router.replace("/sign-in");
  }

  return (
    <AuthShell>
      <div className="authCardContent authCompact">
        <div className="authHeading">
          <h2>{token ? "Choose a new password" : "Reset your password"}</h2>
          <p>{token ? "Enter a new password for your AI Caller account." : "Enter the email associated with your account and we’ll send you a reset link."}</p>
        </div>

        {token ? (
          <form className="authForm" onSubmit={resetPassword}>
            <PasswordField id="newPassword" autoComplete="new-password" placeholder="New password" />
            <PasswordField id="confirmPassword" label="Confirm password" autoComplete="new-password" placeholder="Confirm new password" />
            {error ? <p role="alert" style={{ margin: 0, color: "#c62828", fontSize: 13 }}>{error}</p> : null}
            <button className="primaryButton" type="submit" disabled={pending}>
              <span>{pending ? "Saving..." : "Reset Password"}</span><ArrowRightIcon size={19} />
            </button>
          </form>
        ) : (
          <form className="authForm" onSubmit={requestReset}>
            <label className="field" htmlFor="email">
              <span className="fieldLabel">Email address</span>
              <input id="email" name="email" type="email" autoComplete="email" placeholder="you@business.com" required />
            </label>
            {error ? <p role="alert" style={{ margin: 0, color: "#c62828", fontSize: 13 }}>{error}</p> : null}
            {message ? <p role="status" style={{ margin: 0, color: "#138a58", fontSize: 13 }}>{message}</p> : null}
            <button className="primaryButton" type="submit" disabled={pending}>
              <span>{pending ? "Sending..." : "Send Reset Link"}</span><ArrowRightIcon size={19} />
            </button>
          </form>
        )}

        <div className="switchRow"><Link href="/sign-in">← Back to sign in</Link></div>
      </div>
    </AuthShell>
  );
}
