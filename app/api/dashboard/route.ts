import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import {
  dashboardDayOptions,
  getDashboardOverview,
  type DashboardDays,
} from "@/server/dashboard/service";
import { toErrorResponse } from "@/server/http/errors";

const daysSchema = z.coerce.number().int().refine(
  (value): value is DashboardDays => dashboardDayOptions.includes(value as DashboardDays),
  { message: "Dashboard range must be 7, 30, or 90 days." },
).default(30);

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const url = new URL(request.url);
    const days = daysSchema.parse(url.searchParams.get("days") ?? "30");
    return Response.json(await getDashboardOverview(context.workspace.id, days));
  } catch (error) {
    return toErrorResponse(error);
  }
}
