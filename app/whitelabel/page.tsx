import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getFunnelAccountSummary } from "@/server/commerce/account-licenses";
import { WhitelabelBrandEditor } from "./whitelabel-brand-editor";
import "../dashboard/dashboard.css";
import "./whitelabel.css";

export default async function WhitelabelPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  await assertPlatformUserActive(session.user.id);
  const account = await getFunnelAccountSummary(session.user.id);
  if (!account.effectiveWhitelabel) notFound();
  return <WhitelabelBrandEditor />;
}
