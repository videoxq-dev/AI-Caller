import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { getVoiceCallWithTranscript } from "@/server/voice/repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    const { id } = await params;
    const result = await getVoiceCallWithTranscript(context.workspace.id, id);
    if (!result) throw new AppError("VOICE_CALL_NOT_FOUND", "Voice call not found.", 404);

    return Response.json({
      call: {
        id: result.call.id,
        mode: result.call.mode,
        status: result.call.status,
        startedAt: result.call.startedAt,
        endedAt: result.call.endedAt,
        durationSeconds: result.call.durationSeconds,
        recordingStatus: result.call.recordingStatus,
        recordingDurationSeconds: result.call.recordingDurationSeconds,
        recordingConsentStatus: result.call.recordingConsentStatus,
        recordingDisclosedAt: result.call.recordingDisclosedAt,
        transcriptStatus: result.call.transcriptStatus,
      },
      transcript: result.transcript.map((segment) => ({
        id: segment.id,
        speaker: segment.speaker,
        text: segment.text,
        startedMs: segment.startedMs,
        endedMs: segment.endedMs,
        sequence: segment.sequence,
        confidence: segment.confidenceBps == null ? null : segment.confidenceBps / 10_000,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
