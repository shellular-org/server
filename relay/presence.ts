import { logger } from "@shared/logger";
import {
  type RelayPresenceMsg,
  RelayPresenceMsgType,
  WS_AUTH_HEADER,
  WS_PATH,
} from "@shared/relay-presence";
import WebSocket from "ws";
import { relayEnv } from "./env";
import { getPresenceSnapshot } from "./sessions";

/**
 * The relay's persistent presence WebSocket to central (`/relay`). This single
 * socket is the relay's liveness signal (central marks it live while open, drops it
 * on close — no HTTP register/heartbeat) and the channel it reports host/client
 * presence over. Authenticated by the shared secret in the `x-relay-secret` header.
 *
 * It reconnects if it drops; on (re)connect it sends `hello` with the relay's
 * public URL AND a full snapshot of the hosts/clients currently connected to
 * it, so central can rebuild its in-memory registry (which a central restart
 * wipes) without waiting for those CLIs/apps to reconnect. Presence *events* sent
 * while disconnected are dropped (best-effort), but the snapshot on the next
 * reconnect makes central whole again regardless.
 */

const RECONNECT_DELAYS_MS = [1_500];

let ws: WebSocket | null = null;
let closing = false;
let reconnectAttempt = 0;

function presenceWsUrl(): string {
  const url = new URL(relayEnv.CENTRAL_API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = WS_PATH;
  return url.toString();
}

function send(msg: RelayPresenceMsg): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect(): void {
  if (closing) return;

  ws = new WebSocket(presenceWsUrl(), {
    headers: { [WS_AUTH_HEADER]: relayEnv.RELAY_SECRET },
  });

  ws.on("open", () => {
    reconnectAttempt = 0;
    logger.info(
      `Relay ${relayEnv.RELAY_PUBLIC_URL} connected to ${relayEnv.CENTRAL_API_URL}`,
    );
    // Announce identity AND current presence in one frame. If central just
    // restarted (or this socket merely dropped and reconnected), this rebuilds its
    // in-memory registry for us — every host/client already on this relay is
    // re-registered immediately, no waiting for them to churn.
    const { hostIds, clientIds } = getPresenceSnapshot();
    send({
      type: RelayPresenceMsgType.HELLO,
      publicUrl: relayEnv.RELAY_PUBLIC_URL,
      hostIds,
      clientIds,
    });
  });

  ws.on("close", scheduleReconnect);
  ws.on("error", (err) => {
    logger.warn("Relay socket error:", err.message);
    // 'close' fires after 'error'; reconnect is scheduled there.
  });
}

function scheduleReconnect(): void {
  if (closing) return;
  const delay =
    RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
  reconnectAttempt++;
  logger.warn(
    `Relay presence websocket disconnected from central; reconnecting in ${delay / 1000}s`,
  );
  setTimeout(connect, delay).unref?.();
}

/** Open the presence websocket to central (with auto-reconnect). */
export function initRelayPresenceToCentral(): void {
  closing = false;
  reconnectAttempt = 0;
  connect();
}

/** Close the presence websocket for good (graceful shutdown → central drops us). */
export function endRelayPresenceToCentral(): void {
  closing = true;
  ws?.close();
  ws = null;
}

// ── Presence reports (over the presence websocket) ───────────────────────────────
export function reportHostOnline(hostId: string): void {
  send({ type: RelayPresenceMsgType.HOST_ONLINE, hostId });
}

export function reportHostOffline(hostId: string): void {
  send({ type: RelayPresenceMsgType.HOST_OFFLINE, hostId });
}

export function reportClientOnline(clientId: string): void {
  send({ type: RelayPresenceMsgType.CLIENT_ONLINE, clientId });
}

export function reportClientOffline(clientId: string): void {
  send({ type: RelayPresenceMsgType.CLIENT_OFFLINE, clientId });
}
