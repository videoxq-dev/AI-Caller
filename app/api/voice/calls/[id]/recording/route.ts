import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { getVoiceCall } from "@/server/voice/repository";
import { getVoiceRecording } from "@/server/voice/storage";

function parseRange(value: string | null) {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) throw new AppError("INVALID_AUDIO_RANGE", "Invalid audio byte range.", 416);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    throw new AppError("INVALID_AUDIO_RANGE", "Invalid audio byte range.", 416);
  }
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const call = await getVoiceCall(context.workspace.id, id);
    if (!call) throw new AppError("VOICE_CALL_NOT_FOUND", "Voice call not found.", 404);
    if (call.recordingStatus !== "AVAILABLE" || !call.recordingObjectKey) {
      throw new AppError("VOICE_RECORDING_NOT_AVAILABLE", "Call recording is not available.", 404);
    }

    const object = await getVoiceRecording(call.recordingObjectKey, parseRange(request.headers.get("range")));
    const headers = new Headers({
      "content-type": call.recordingMimeType ?? object.contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": 'inline; filename="call-recording"',
    });
    if (object.contentLength != null) headers.set("content-length", String(object.contentLength));
    if (object.contentRange) headers.set("content-range", object.contentRange);
    return new Response(object.body, { status: object.status, headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
