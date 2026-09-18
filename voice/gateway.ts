import "dotenv/config";
import http from "node:http";
import { WebSocketServer } from "ws";
import { getEnv } from "@/server/env";
import { logger } from "@/server/observability/logger";
import { verifyVoiceGatewayRequest } from "@/server/voice/gateway-auth";

type TelnyxStreamFrame = {
  event?: unknown;
  start?: {
    call_session_id?: unknown;
    call_control_id?: unknown;
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

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const auth = verifyVoiceGatewayRequest(url);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, auth);
    });
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

wss.on("connection", (ws, _request, auth: ReturnType<typeof verifyVoiceGatewayRequest>) => {
  if (!auth) {
    ws.close(1008, "Unauthorized");
    return;
  }

  let verifiedStart = false;
  let mediaBytes = 0;
  let mediaFrames = 0;

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
      verifiedStart = true;
      logger.info({ workspaceId: auth.workspaceId, callId: auth.callId }, "Inbound voice media stream started");
      return;
    }

    if (frame.event === "media") {
      if (!verifiedStart) {
        ws.close(1008, "Media arrived before verified start");
        return;
      }
      const payload = typeof frame.media?.payload === "string" ? frame.media.payload : "";
      if (!payload) return;
      mediaFrames += 1;
      mediaBytes += Buffer.byteLength(payload, "base64");
      return;
    }

    if (frame.event === "stop") ws.close(1000, "Stream ended");
  });

  ws.on("close", () => {
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
