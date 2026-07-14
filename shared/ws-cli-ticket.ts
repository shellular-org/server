import { z } from "zod";

import { createToken, verifyToken } from "./jwt";

/**
 * How long a host/CLI ticket is valid. Unlike the app ticket (30s), the CLI holds
 * a long-lived WebSocket and the ticket is spent exactly once at connect time —
 * but the CLI may reconnect (network blips, relay failover), and re-minting on
 * every reconnect would add a central round-trip to the reconnect path. A
 * minutes-scale window lets a cached ticket cover a reconnect without another
 * `/relays/resolve`, while still bounding replay. The CLI refreshes via a fresh
 * `/relays/resolve` once the ticket is close to expiry.
 */
const CLI_WEBSOCKET_TOKEN_TTL_SECONDS = 600;

/**
 * Claims the relay needs to trust a CLI connection WITHOUT touching the database.
 * `hostId`/`machineId`/`platform` are exactly the triple which are verified
 * against the DB by the central server, after which it signs them here, so a regional
 * relay only has to check the signature.
 *
 * The CLI token is intentionally NOT region-bound: `/relays/resolve` mints it in
 * the same call that returns the relay list, before the CLI has probed and picked
 * a region, so any relay accepts it.
 */
const VerifiedHostSchema = z.object({
  hostId: z.string().min(1),
  machineId: z.string().min(1),
  platform: z.string().min(1),
});

export type VerifiedHost = z.infer<typeof VerifiedHostSchema>;

export async function createCliWebSocketToken(
  hostInfo: VerifiedHost,
): Promise<{ token: string; ttlSeconds: number }> {
  const token = await createToken(hostInfo, CLI_WEBSOCKET_TOKEN_TTL_SECONDS);
  return { token, ttlSeconds: CLI_WEBSOCKET_TOKEN_TTL_SECONDS };
}

export async function verifyCliWebSocketToken(
  token: string,
): Promise<VerifiedHost | null> {
  return verifyToken(token, VerifiedHostSchema);
}
