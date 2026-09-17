import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { getAppointment } from "@/server/domain/core/repository";
import { AppError, toErrorResponse } from "@/server/http/errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const appointment = await getAppointment(context.workspace.id, id);
    if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    return Response.json({ appointment });
  } catch (error) {
    return toErrorResponse(error);
  }
}
