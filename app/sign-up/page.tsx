import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { ArrowRightIcon, CheckIcon, LockIcon, RocketIcon } from "@/components/icons";
import { PasswordField } from "@/components/password-field";

export default function SignUpPage() {
  return (
    <AuthShell>
      <div className="authCardContent">
        <div className="authHeading">
          <h2>Create your account</h2>
          <p>Get started in under a minute.</p>
        </div>

        <div className="purchaseBanner">
          <span className="successIcon"><CheckIcon size={22} /></span>
          <div><strong>Purchase confirmed</strong><span>Your Core license is ready to activate.</span></div>
        </div>

        <form className="authForm">
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

          <button className="primaryButton" type="submit">
            <span>Create Account</span><ArrowRightIcon size={19} />
          </button>
        </form>

        <div className="switchRow"><span>Already have an account?</span><Link href="/sign-in">Sign in</Link></div>

        <div className="pathHint">
          <RocketIcon size={21} />
          <div><strong>Create account&nbsp; → &nbsp;Setup wizard&nbsp; → &nbsp;Go live</strong><span>You&apos;ll be up and running in just a few minutes.</span></div>
        </div>
      </div>
    </AuthShell>
  );
}
