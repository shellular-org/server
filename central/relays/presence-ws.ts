import type http from "node:http";

import { env } from "@central/env";
import {
  addLiveRelay,
  dropRelay,
  markClientOffline,
  markClientOnline,
  markHostOffline,
  markHostOnline,
} from "@central/relays/registry";
import { logger } from "@shared/logger";
import {
  parseRelayPresenceMsg,
  RelayPresenceMsgType,
  WS_AUTH_HEADER,
  WS_PATH,
} from "@shared/relay-presence";
import { rejectUpgrade } from "@shared/ws-helpers";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * Central's `/relay` presence-channel server. Each regional relay holds ONE
 * persistent WebSocket here; the socket itself is the relay liveness signal
 * (open = live, closed = dead), and the relay reports host/client presence as
 * messages over it. Authenticated by the shared `x-relay-secret` header at upgrade.
 */

// Ping every 30s; a socket that misses a pong between two cycles is terminated so a
// half-open relay connection (no FIN, e.g. network partition) is detected.
const PING_INTERVAL_MS = 30_000;

const wsServer = new WebSocketServer({ noServer: true });

/**
 * Attach the relay presence channel upgrade handler to central's http server. Returns a
 * predicate the main upgrade router can use to claim `/relay` upgrades.
 */
export function initRelayPresenceWs(server: http.Server): void {
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "/", "http://localhost");
    if (pathname !== WS_PATH) {
      return;
    }

    if (request.headers[WS_AUTH_HEADER] !== env.RELAY_SECRET) {
      logger.warn("Rejecting relay presence WS: invalid relay secret");
      rejectUpgrade(socket);
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  });

  setupKeepAlive();

  wsServer.on("connection", (ws) => {
    // The relay's URL, learned from its `hello`. Until then the socket is live but
    // not yet routable; on close we use this to drop the relay + its presence.
    let relayUrl: string | null = null;

    ws.on("message", (raw) => {
      const msg = parseRelayPresenceMsg(raw.toString());
      if (!msg) {
        logger.warn("Ignoring malformed relay presence message");
        return;
      }

      switch (msg.type) {
        case RelayPresenceMsgType.HELLO:
          relayUrl = msg.publicUrl;
          addLiveRelay(relayUrl);
          logger.info(`Relay connected: ${relayUrl}`);
          break;
        case RelayPresenceMsgType.HOST_ONLINE:
          if (!relayUrl) {
            logger.error("Somehow got a host-online before hello; ignoring");
            return;
          }

          markHostOnline(msg.hostId, relayUrl);
          break;
        case RelayPresenceMsgType.HOST_OFFLINE:
          markHostOffline(msg.hostId);
          break;
        case RelayPresenceMsgType.CLIENT_ONLINE:
          if (!relayUrl) {
            logger.error("Somehow got a client-online before hello; ignoring");
            return;
          }

          markClientOnline(msg.clientId, relayUrl);
          break;
        case RelayPresenceMsgType.CLIENT_OFFLINE:
          markClientOffline(msg.clientId);
          break;
      }
    });

    const onGone = () => {
      if (relayUrl) {
        logger.info(`Relay disconnected: ${relayUrl}`);
        dropRelay(relayUrl);
        relayUrl = null;
      }
    };

    ws.on("close", onGone);
    ws.on("error", onGone);
  });
}

/** Ping/pong sweep to detect half-open relay sockets. */
function setupKeepAlive(): void {
  const alive = new WeakSet<WebSocket>();
  wsServer.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });

  const interval = setInterval(() => {
    for (const ws of wsServer.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  interval.unref(); // don't keep the process alive just for this timer

  wsServer.on("close", () => clearInterval(interval));
}
