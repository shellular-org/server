import { logger } from "@shared/logger";
import {
  type RelayPresenceMsg,
  RelayPresenceMsgType,
  WS_AUTH_HEADER,
  WS_PATH,
} from "@shared/relay-presence";
import WebSocket from "ws";
import { relayEnv } from "./env";

/**
 * The relay's persistent presence WebSocket to central (`/relay`). This single
 * socket is the relay's liveness signal (central marks it live while open, drops it
 * on close — no HTTP register/heartbeat) and the channel it reports host/client
 * presence over. Authenticated by the shared secret in the `x-relay-secret` header.
 *
 * It reconnects with backoff if it drops; on (re)connect it sends `hello` with the
 * relay's public URL so central knows which URL to route apps to. Presence sent
 * while disconnected is dropped (best-effort) — central re-derives on reconnect as
 * the relay re-reports, and any host/client on a dropped relay re-resolves anyway.
 */

const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 16_000, 32_000];

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
    send({
      type: RelayPresenceMsgType.HELLO,
      publicUrl: relayEnv.RELAY_PUBLIC_URL,
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
