import "dotenv/config";
import http from "node:http";
import { WebSocketServer } from "ws";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";
import { verifyVoiceGatewayRequest } from "@/server/voice/gateway-auth";
import { attachRealtimeMedia } from "@/server/voice/realtime-media";
import { getVoiceCall } from "@/server/voice/repository";

type TelnyxStreamFrame = {
  event?: unknown;
  stream_id?: unknown;
  start?: {
    call_session_id?: unknown;
    call_control_id?: unknown;
    stream_id?: unknown;
    media_format?: { encoding?: unknown; sample_rate?: unknown };
  };
  media?: {
    payload?: unknown;
  };
};

const env = getEnv();
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const authByRequest = new WeakMap<object, NonNullable<ReturnType<typeof verifyVoiceGatewayRequest>>>();

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const auth = verifyVoiceGatewayRequest(url);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    authByRequest.set(request, auth);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

wss.on("connection", (ws, request) => {
  const auth = authByRequest.get(request);
  authByRequest.delete(request);
  if (!auth) {
    ws.close(1008, "Unauthorized");
    return;
  }

  let verifiedStart = false;
  let mediaBytes = 0;
  let mediaFrames = 0;
  let realtime: ReturnType<typeof attachRealtimeMedia> | null = null;
  let mediaStarting = false;
  const awaitingAuthorizationMedia: string[] = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, "JSON media frames required");
      return;
    }

    let frame: TelnyxStreamFrame;
    try {
      frame = JSON.parse(data.toString()) as TelnyxStreamFrame;
    } catch {
      ws.close(1007, "Invalid JSON frame");
      return;
    }

    if (frame.event === "connected") return;

    if (frame.event === "start") {
      const externalCallId = typeof frame.start?.call_session_id === "string"
        ? frame.start.call_session_id
        : "";
      if (externalCallId !== auth.externalCallId) {
        ws.close(1008, "Call identity mismatch");
        return;
      }
      if (verifiedStart || mediaStarting) {
        ws.close(1008, "Duplicate stream start");
        return;
      }
      mediaStarting = true;
      const streamId = typeof frame.stream_id === "string" ? frame.stream_id : "";
      void getVoiceCall(auth.workspaceId, auth.callId).then((call) => {
        if (!call || call.externalCallId !== auth.externalCallId || !["RINGING", "ACTIVE"].includes(call.status)) {
          ws.close(1008, "Voice call is not active");
          return;
        }
        if (call.metadata.voiceTechnology === "REALTIME") {
          if (!streamId || frame.start?.media_format?.encoding !== "PCMU"
            || frame.start.media_format.sample_rate !== 8000) {
            ws.close(1003, "Realtime PCMU 8000 Hz required");
            return;
          }
          realtime = attachRealtimeMedia({
            telnyx: ws, identity: auth, streamId,
          });
        }
        verifiedStart = true;
        for (const payload of awaitingAuthorizationMedia) {
          realtime?.onMedia(payload);
        }
        awaitingAuthorizationMedia.length = 0;
        logger.info({ workspaceId: auth.workspaceId, callId: auth.callId,
          technology: call.metadata.voiceTechnology ?? "STANDARD" },
          "Inbound voice media stream started");
      }).catch((err) => {
        logger.error({ err, workspaceId: auth.workspaceId, callId: auth.callId },
          "Voice gateway could not authorize the call");
        ws.close(1011, "Voice session unavailable");
      });
      return;
    }

    if (frame.event === "media") {
      if (!verifiedStart && !mediaStarting) {
        ws.close(1008, "Media arrived before stream start");
        return;
      }
      const payload = typeof frame.media?.payload === "string" ? frame.media.payload : "";
      if (!verifiedStart) {
        if (awaitingAuthorizationMedia.length >= 100) {
          ws.close(1009, "Authorization media buffer exceeded");
          return;
        }
        if (payload.length > 65_536) {
          ws.close(1009, "Media frame too large");
          return;
        }
        awaitingAuthorizationMedia.push(payload);
        return;
      }
      if (!payload) return;
      mediaFrames += 1;
      mediaBytes += Buffer.byteLength(payload, "base64");
      realtime?.onMedia(payload);
      return;
    }

    if (frame.event === "stop") {
      if (realtime) void realtime.stop();
      else ws.close(1000, "Stream ended");
    }
  });

  ws.on("close", () => {
    if (realtime) void realtime.stop();
    logger.info(
      { workspaceId: auth.workspaceId, callId: auth.callId, mediaFrames, mediaBytes },
      "Inbound voice media stream closed",
    );
  });

  ws.on("error", (error) => {
    logger.warn({ err: error, workspaceId: auth.workspaceId, callId: auth.callId }, "Inbound voice media stream error");
  });
});

server.listen(env.VOICE_GATEWAY_PORT, () => {
  logger.info({ port: env.VOICE_GATEWAY_PORT }, "Voice gateway listening");
});

function shutdown() {
  wss.clients.forEach((client) => client.close(1001, "Gateway shutting down"));
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
