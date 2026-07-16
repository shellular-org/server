import { z } from "zod";

/**
 * Messages the relay sends to central over a persistent WebSocket
 * (central's `/relay` channel). This one socket replaces the old HTTP
 * register/heartbeat/presence dance:
 *
 * - liveness is the socket itself — central marks the relay live while it's open
 *   and drops it (plus all its hosts/clients) the instant it closes.
 * - presence (host/client connect/disconnect) flows as websocket messages instead of
 *   individual HTTP requests.
 *
 * The relay authenticates with the shared secret in the `x-relay-secret` header at
 * the upgrade, and identifies itself with `RELAY_PUBLIC_URL` via the `hello`
 * message so central knows which URL to route apps to.
 */
export const RelayPresenceMsgType = {
  HELLO: "hello",
  HOST_ONLINE: "host-online",
  HOST_OFFLINE: "host-offline",
  CLIENT_ONLINE: "client-online",
  CLIENT_OFFLINE: "client-offline",
} as const;

export const WS_PATH = "/relay";
export const WS_AUTH_HEADER = "x-relay-secret";

const HelloMsgSchema = z.object({
  type: z.literal(RelayPresenceMsgType.HELLO),
  /** The relay's public URL — its identity/route in central's fleet. */
  publicUrl: z.string().min(1),
  /**
   * Full presence snapshot at (re)connect: every host/client currently connected
   * to this relay. Central's registry is in-memory, so a central restart wipes it;
   * the relays' own sockets survive that restart, and each one re-announces its live
   * presence here so central rebuilds the `hostId/clientId → relayUrl` map without
   * waiting for the underlying CLIs/apps to reconnect.
   */
  hostIds: z.array(z.string()),
  clientIds: z.array(z.string()),
});

const HostOnlineMsgSchema = z.object({
  type: z.literal(RelayPresenceMsgType.HOST_ONLINE),
  hostId: z.string().min(1),
});

const HostOfflineMsgSchema = z.object({
  type: z.literal(RelayPresenceMsgType.HOST_OFFLINE),
  hostId: z.string().min(1),
});

const ClientOnlineMsgSchema = z.object({
  type: z.literal(RelayPresenceMsgType.CLIENT_ONLINE),
  clientId: z.string().min(1),
});

const ClientOfflineMsgSchema = z.object({
  type: z.literal(RelayPresenceMsgType.CLIENT_OFFLINE),
  clientId: z.string().min(1),
});

export const RelayPresenceMsgSchema = z.discriminatedUnion("type", [
  HelloMsgSchema,
  HostOnlineMsgSchema,
  HostOfflineMsgSchema,
  ClientOnlineMsgSchema,
  ClientOfflineMsgSchema,
]);

export type RelayPresenceMsg = z.infer<typeof RelayPresenceMsgSchema>;
export type RelayHelloMsg = z.infer<typeof HelloMsgSchema>;

/** Parse a raw control-channel frame; returns null on malformed input. */
export function parseRelayPresenceMsg(raw: string): RelayPresenceMsg | null {
  try {
    const parsed = RelayPresenceMsgSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
