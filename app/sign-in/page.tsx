"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon } from "@/components/icons";
import { PasswordField } from "@/components/password-field";
import { authClient } from "@/lib/auth-client";
import { safeReturnPath } from "@/lib/safe-return-path";

export default function SignInPage() {
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/dashboard");
  useEffect(() => {
    setReturnTo(safeReturnPath(new URLSearchParams(window.location.search).get("returnTo"), "/dashboard"));
  }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "Unable to sign in.");
      setPending(false);
      return;
    }

    router.replace(returnTo);
  }

  return (
    <AuthShell>
      <div className="authCardContent authCompact">
        <div className="authHeading">
          <h2>Welcome back</h2>
          <p>Sign in to continue to AI Caller.</p>
        </div>

        <form className="authForm" onSubmit={handleSubmit}>
          <label className="field" htmlFor="email">
            <span className="fieldLabel">Email address</span>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="you@business.com" required />
          </label>

          <div className="passwordHeader"><span>Password</span><Link href="/forgot-password">Forgot password?</Link></div>
          <PasswordField id="password" label="" placeholder="Enter your password" />

          {error ? <p role="alert" style={{ margin: 0, color: "#c62828", fontSize: 13 }}>{error}</p> : null}

          <button className="primaryButton" type="submit" disabled={pending}>
            <span>{pending ? "Signing in..." : "Sign In"}</span><ArrowRightIcon size={19} />
          </button>
        </form>

        <div className="switchRow"><span>Don&apos;t have an account?</span><Link href={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Create account</Link></div>
      </div>
    </AuthShell>
  );
}
