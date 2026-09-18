import { AppError, toErrorResponse } from "@/server/http/errors";
import { getWebchatSessionHistory } from "@/server/webchat/repository";

function bearerToken(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token || null;
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) throw new AppError("WEBCHAT_UNAUTHORIZED", "A valid web chat session is required.", 401);
    const resolved = await getWebchatSessionHistory(token);
    if (!resolved) throw new AppError("WEBCHAT_SESSION_EXPIRED", "The web chat session is invalid or expired.", 401);
    return Response.json({ history: resolved.history }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
