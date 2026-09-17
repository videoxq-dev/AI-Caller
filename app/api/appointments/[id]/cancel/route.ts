import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const appointment = await calendarBookingService.cancel(context.workspace.id, id);
    return Response.json({ appointment });
  } catch (error) {
    return toErrorResponse(error);
  }
}
