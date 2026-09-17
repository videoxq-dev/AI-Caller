import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { listAppointments } from "@/server/domain/core/repository";
import { appointmentInputSchema, appointmentListQuerySchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = parseInput(appointmentListQuerySchema, query);
    return Response.json(await listAppointments(context.workspace.id, input));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(appointmentInputSchema, await request.json());
    const appointment = await calendarBookingService.book(context.workspace.id, input);
    return Response.json({ appointment }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
