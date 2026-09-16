import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon } from "@/components/icons";

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <div className="authCardContent authCompact">
        <div className="authHeading">
          <h2>Reset your password</h2>
          <p>Enter the email associated with your account and we&apos;ll send you a reset link.</p>
        </div>

        <form className="authForm">
          <label className="field" htmlFor="email">
            <span className="fieldLabel">Email address</span>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="you@business.com" required />
          </label>

          <button className="primaryButton" type="submit">
            <span>Send Reset Link</span><ArrowRightIcon size={19} />
          </button>
        </form>

        <div className="switchRow"><Link href="/sign-in">← Back to sign in</Link></div>
      </div>
    </AuthShell>
  );
}
