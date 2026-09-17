import { AppError, toErrorResponse } from "@/server/http/errors";
import { parseInput } from "@/server/http/validation";
import { createOrResumeWebchatSession } from "@/server/webchat/repository";
import { webchatSessionInputSchema } from "@/server/webchat/schemas";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input = parseInput(webchatSessionInputSchema, body);
    const result = await createOrResumeWebchatSession(input);
    if (!result) throw new AppError("WIDGET_NOT_FOUND", "Web chat widget not found.", 404);

    return Response.json({
      sessionToken: result.sessionToken,
      visitorId: result.visitorId,
      history: result.history,
      widget: {
        publicKey: result.widget.publicKey,
        businessName: result.widget.businessName,
        assistantName: result.widget.assistantName,
        greeting: result.widget.greeting,
        launcherLabel: result.widget.launcherLabel,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
