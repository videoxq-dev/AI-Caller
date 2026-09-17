import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { appointmentRescheduleSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const input = parseInput(appointmentRescheduleSchema, await request.json());
    const appointment = await calendarBookingService.reschedule(context.workspace.id, id, input);
    return Response.json({ appointment });
  } catch (error) {
    return toErrorResponse(error);
  }
}
