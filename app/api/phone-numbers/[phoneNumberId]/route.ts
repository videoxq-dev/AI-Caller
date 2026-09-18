import { z } from "zod";
import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { releaseManagedPhoneNumber } from "@/server/phone-numbers/service";

const paramsSchema = z.object({ phoneNumberId: z.string().uuid() });

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ phoneNumberId: string }> },
) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new AppError("INVALID_PHONE_NUMBER_ID", "Invalid phone number.", 400);
    const number = await releaseManagedPhoneNumber(context.workspace.id, parsed.data.phoneNumberId);
    return Response.json({ number });
  } catch (error) {
    return toErrorResponse(error);
  }
}
