"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon, CheckIcon, LockIcon, RocketIcon } from "@/components/icons";
import { PasswordField } from "@/components/password-field";
import { authClient } from "@/lib/auth-client";
import { safeReturnPath } from "@/lib/safe-return-path";

export default function SignUpPage() {
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/welcome");
  useEffect(() => {
    setReturnTo(safeReturnPath(new URLSearchParams(window.location.search).get("returnTo"), "/welcome"));
  }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) {
      setError(result.error.message ?? "Unable to create your account.");
      setPending(false);
      return;
    }

    router.replace(returnTo);
  }

  return (
    <AuthShell>
      <div className="authCardContent">
        <div className="authHeading">
          <h2>Create your account</h2>
          <p>Get started in under a minute.</p>
        </div>

        <div className="purchaseBanner">
          <span className="successIcon"><CheckIcon size={22} /></span>
          <div><strong>{returnTo.startsWith("/team/invite") ? "Team invitation" : "Purchase confirmed"}</strong><span>{returnTo.startsWith("/team/invite") ? "Create your account, then accept the workspace invitation." : "Your Core license is ready to activate."}</span></div>
        </div>

        <form className="authForm" onSubmit={handleSubmit}>
          <label className="field" htmlFor="name">
            <span className="fieldLabel">Full name</span>
            <input id="name" name="name" type="text" autoComplete="name" placeholder="Alex Carter" required />
          </label>

          <label className="field" htmlFor="email">
            <span className="fieldLabel">Email address</span>
            <span className="lockedInput">
              <input id="email" name="email" type="email" autoComplete="email" placeholder="you@business.com" required />
              <LockIcon size={17} />
            </span>
          </label>

          <PasswordField id="password" autoComplete="new-password" placeholder="Create a password" />

          <label className="termsRow">
            <input type="checkbox" required defaultChecked />
            <span>I agree to the <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.</span>
          </label>

          {error ? <p role="alert" style={{ margin: 0, color: "#c62828", fontSize: 13 }}>{error}</p> : null}

          <button className="primaryButton" type="submit" disabled={pending}>
            <span>{pending ? "Creating account..." : "Create Account"}</span><ArrowRightIcon size={19} />
          </button>
        </form>

        <div className="switchRow"><span>Already have an account?</span><Link href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link></div>

        <div className="pathHint">
          <RocketIcon size={21} />
          <div><strong>Create account&nbsp; → &nbsp;Setup wizard&nbsp; → &nbsp;Go live</strong><span>You&apos;ll be up and running in just a few minutes.</span></div>
        </div>
      </div>
    </AuthShell>
  );
}
