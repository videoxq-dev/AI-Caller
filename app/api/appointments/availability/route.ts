import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { calendarBookingService } from "@/server/domain/core/calendar-booking";
import { availabilityInputSchema } from "@/server/domain/core/schemas";
import { toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const input = parseInput(availabilityInputSchema, await request.json());
    const availability = await calendarBookingService.getAvailability(context.workspace.id, input);
    return Response.json({ slots: availability.slots, timezone: availability.timezone });
  } catch (error) {
    return toErrorResponse(error);
  }
}
