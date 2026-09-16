import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon } from "@/components/icons";
import { PasswordField } from "@/components/password-field";

export default function SignInPage() {
  return (
    <AuthShell>
      <div className="authCardContent authCompact">
        <div className="authHeading">
          <h2>Welcome back</h2>
          <p>Sign in to continue to AI Caller.</p>
        </div>

        <form className="authForm">
          <label className="field" htmlFor="email">
            <span className="fieldLabel">Email address</span>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="you@business.com" required />
          </label>

          <div className="passwordHeader"><span>Password</span><Link href="/forgot-password">Forgot password?</Link></div>
          <PasswordField id="password" label="" placeholder="Enter your password" />

          <button className="primaryButton" type="submit">
            <span>Sign In</span><ArrowRightIcon size={19} />
          </button>
        </form>

        <div className="switchRow"><span>Don&apos;t have an account?</span><Link href="/sign-up">Create account</Link></div>
      </div>
    </AuthShell>
  );
}
