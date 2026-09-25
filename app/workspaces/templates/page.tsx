import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppNav } from "@/components/core-domain/app-nav";
import { auth } from "@/server/auth";
import { assertPlatformUserActive } from "@/server/admin/auth";
import { getFunnelAccountSummary } from "@/server/commerce/account-licenses";
import { getAgencyClientLimit } from "@/server/commerce/products";
import { AgencyTemplateLibrary } from "./template-library";
import "../../dashboard/dashboard.css";
import "../workspaces.css";

export default async function AgencyTemplatesPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  await assertPlatformUserActive(session.user.id);
  const account = await getFunnelAccountSummary(session.user.id);
  if (getAgencyClientLimit(account.activeProducts) === null) notFound();

  return (
    <div className="appShell">
      <AppNav active="Workspaces" />
      <section className="appWorkspace">
        <AgencyTemplateLibrary />
      </section>
    </div>
  );
}
