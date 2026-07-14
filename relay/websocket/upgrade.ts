import type http from "node:http";
import type { Duplex } from "node:stream";

import { relayEnv } from "@relay/env";
import { captureAppConnection, captureCliConnection } from "@relay/posthog";
import {
  reportClientOffline,
  reportClientOnline,
  reportHostOffline,
  reportHostOnline,
} from "@relay/presence";
import { getActiveSessionForHost, joinSession } from "@relay/sessions";
import {
  initAppWebSocket,
  requestClientApprovalFromHost,
} from "@relay/websocket/app";
import { type CliWebSocketHooks, initCliWebSocket } from "@relay/websocket/cli";
import { CloseCodeAndReason, closeWsWithError } from "@relay/websocket/shared";
import { logger } from "@shared/logger";
import { verifyAppWebSocketToken } from "@shared/ws-app-ticket";
import { verifyCliWebSocketToken } from "@shared/ws-cli-ticket";
import { rejectUpgrade } from "@shared/ws-helpers";
import type { AuthedClientInfo } from "@shellular/protocol";
import type { WebSocket } from "ws";
import { z } from "zod";

// ─── CLI (host) side ─────────────────────────────────────────────────────────
// The relay owns no DB: the host token, minted and signed by central after it
// verified the host against the DB, is the proof of identity — checked at the WS
// upgrade below. On connect the relay reports presence (steers apps here + feeds
// central's /stats) and captures the analytics event; presence-offline on close.
const cliHooks: CliWebSocketHooks = {
  onSessionCreated: (hostInfo) => {
    reportHostOnline(hostInfo.id);
    captureCliConnection(hostInfo);
  },
  onSessionClosed: (hostId) => reportHostOffline(hostId),
};

const cliWsServer = initCliWebSocket(cliHooks);
const appWsServer = initAppWebSocket({
  onClientJoined: (clientInfo, hostPlatform) => {
    reportClientOnline(clientInfo.clientId);
    // Every app connection here is authenticated (the app ticket requires a
    // `user`), so a proven userId is always present for analytics.
    if (clientInfo.user) {
      captureAppConnection(clientInfo.user.id, clientInfo, hostPlatform);
    }
  },
  onClientLeft: (clientId) => reportClientOffline(clientId),
});

const HostTokenQuerySchema = z.object({ token: z.string().min(1) });
const AppAuthQuerySchema = z.object({ wsToken: z.string().min(1) }).strict();

export function initRelayUpgrade(server: http.Server) {
  server.on("upgrade", (request, socket, head) => {
    void handleUpgradeRequest(request, socket, head);
  });
  return { cliWsServer, appWsServer };
}

async function handleUpgradeRequest(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const { pathname, searchParams } = new URL(
    request.url || "/",
    "http://localhost",
  );
  const query = Object.fromEntries(searchParams.entries());

  logger.info(`[relay ${relayEnv.RELAY_PUBLIC_URL}] upgrade: ${pathname}`);

  if (pathname === "/cli") {
    await handleCliUpgrade(request, socket, head, query);
    return;
  }

  if (pathname === "/app") {
    await handleAppUpgrade(request, socket, head, query);
    return;
  }

  rejectUpgrade(socket);
}

async function handleCliUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  query: Record<string, string>,
): Promise<void> {
  const parsed = HostTokenQuerySchema.safeParse(query);
  if (!parsed.success) {
    rejectUpgrade(socket);
    return;
  }

  // Verify the token BEFORE upgrading — jose verification is async, and doing it
  // inside the handleUpgrade callback would delay `emit("connection")` past the
  // first inbound frame, so the CLI's `session:host` message could arrive before
  // the connection handler attaches its listener and be lost.
  const payload = await verifyCliWebSocketToken(parsed.data.token);
  if (!payload) {
    logger.warn("Rejecting CLI websocket: invalid or expired host token");
    rejectUpgrade(socket);
    return;
  }

  // No region check: the CLI token is deliberately region-less (minted before the
  // CLI picks a relay), so any relay accepts it. The APP ticket still carries a
  // region — central sets it from the host's presence — which the app path guards.
  cliWsServer.handleUpgrade(request, socket, head, (ws) => {
    cliWsServer.emit("connection", ws, request);
  });
}

async function handleAppUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  query: Record<string, string>,
): Promise<void> {
  const authParsed = AppAuthQuerySchema.safeParse(query);
  if (!authParsed.success) {
    logger.warn("Rejecting app websocket: missing or invalid wsToken");
    rejectUpgrade(socket);
    return;
  }

  const clientInfo = await verifyAppWebSocketToken(authParsed.data.wsToken);
  if (!clientInfo) {
    logger.warn("Rejecting app websocket: invalid or expired wsToken");
    rejectUpgrade(socket);
    return;
  }

  appWsServer.handleUpgrade(request, socket, head, async (ws) => {
    await attachApp(ws, clientInfo, request);
  });
}

async function attachApp(
  ws: WebSocket,
  clientInfo: AuthedClientInfo,
  request: http.IncomingMessage,
): Promise<void> {
  const session = getActiveSessionForHost(clientInfo.hostId);
  if (!session) {
    logger.info(
      `Rejecting app websocket: no active session for hostId=${clientInfo.hostId}`,
    );
    const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
    closeWsWithError(ws, code, reason);
    return;
  }

  const failure = await requestClientApprovalFromHost(session, clientInfo);
  if (failure) {
    logger.info(
      `Rejecting app websocket: approval failure for hostId=${clientInfo.hostId} clientId=${clientInfo.clientId} reason=${failure.reason}`,
    );
    closeWsWithError(ws, failure.code, failure.reason);
    return;
  }

  const joined = joinSession(session.id, ws, clientInfo);
  if (!joined) {
    const { code, reason } = CloseCodeAndReason.SESSION_JOIN_FAILED;
    logger.info(
      `Rejecting app websocket: join failed for hostId=${clientInfo.hostId} clientId=${clientInfo.clientId}`,
    );
    closeWsWithError(ws, code, reason);
    return;
  }

  appWsServer.emit("connection", ws, request);
}
