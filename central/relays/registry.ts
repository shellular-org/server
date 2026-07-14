/**
 * Central's live view of the relay fleet, entirely runtime state (no static region
 * table, no TTLs). Liveness is driven by each relay's persistent WebSocket
 * (central's `/relay` channel): a relay is live exactly while its socket is open.
 *
 *
 * When a relay's presence socket drops, `dropRelay` removes it AND all host/client
 * presence pointing at it — everything on a dead relay is unreachable, and those
 * CLIs/apps will re-resolve to a live relay. A central restart drops it all; relays
 * reconnect and re-report.
 */

// ── Live relay fleet ─────────────────────────────────────────────────────────
const liveRelayUrls = new Set<string>();

// ── Presence (hostId / clientId → relayUrl) ──────────────────────────────────
const relayByHostId = new Map<string, string>();
const relayByClientId = new Map<string, string>();

// --- Reverse mappings (relayUrl → hostIds / clientIds) for /stats and dropRelay.
const relayToHostsIds = new Map<string, Set<string>>();
const relayToClientIds = new Map<string, Set<string>>();

/** Mark a relay live (its presence socket connected). */
export function addLiveRelay(url: string): void {
  liveRelayUrls.add(url);
  // Seed empty presence sets so /stats lists a freshly-connected relay even
  // before any host/client has joined it.
  if (!relayToHostsIds.has(url)) {
    relayToHostsIds.set(url, new Set());
  }
  if (!relayToClientIds.has(url)) {
    relayToClientIds.set(url, new Set());
  }
}

/** The URLs of all currently-live relays. Sent to CLI for relay selection. */
export function getLiveRelayUrls(): string[] {
  return [...liveRelayUrls];
}

/** Record that `hostId` is live on the relay at `relayUrl`. */
export function markHostOnline(hostId: string, relayUrl: string): void {
  // If the host was previously on a different relay, drop that stale reverse
  // entry first so the two indexes stay consistent (otherwise the old relay's
  // set would over-count and its dropRelay would clobber this new mapping).
  const prevRelayUrl = relayByHostId.get(hostId);
  if (prevRelayUrl && prevRelayUrl !== relayUrl) {
    relayToHostsIds.get(prevRelayUrl)?.delete(hostId);
  }

  relayByHostId.set(hostId, relayUrl);

  let hosts = relayToHostsIds.get(relayUrl);
  if (!hosts) {
    hosts = new Set();
    relayToHostsIds.set(relayUrl, hosts);
  }

  hosts.add(hostId);
}

/** Clear presence for `hostId` (its CLI disconnected). */
export function markHostOffline(hostId: string): void {
  const relayUrl = relayByHostId.get(hostId);
  if (!relayUrl) {
    return;
  }

  relayByHostId.delete(hostId);

  const hosts = relayToHostsIds.get(relayUrl);
  if (!hosts) {
    return;
  }

  hosts.delete(hostId);
  // Don't prune the empty set: the relay is still live (its presence socket is
  // open), so /stats should keep listing it with 0 hosts. dropRelay clears it.
}

/** Record that a client (app) is connected to the relay at `relayUrl`. */
export function markClientOnline(clientId: string, relayUrl: string): void {
  // Drop a stale reverse entry if this client moved relays (see markHostOnline).
  const prevRelayUrl = relayByClientId.get(clientId);
  if (prevRelayUrl && prevRelayUrl !== relayUrl) {
    relayToClientIds.get(prevRelayUrl)?.delete(clientId);
  }

  relayByClientId.set(clientId, relayUrl);

  let clients = relayToClientIds.get(relayUrl);
  if (!clients) {
    clients = new Set();
    relayToClientIds.set(relayUrl, clients);
  }

  clients.add(clientId);
}

/** Clear a client's presence (its app socket closed on the relay). */
export function markClientOffline(clientId: string): void {
  const relayUrl = relayByClientId.get(clientId);
  if (!relayUrl) {
    return;
  }

  relayByClientId.delete(clientId);

  const clients = relayToClientIds.get(relayUrl);
  if (!clients) {
    return;
  }

  clients.delete(clientId);
  // Keep the empty set while the relay is live (see markHostOffline).
}

/**
 * Remove a relay and all presence pointing at it — called when its presence socket
 * closes (graceful shutdown, crash, or network drop). Everything that was on it is
 * gone in one shot.
 */
export function dropRelay(relayUrl: string): void {
  liveRelayUrls.delete(relayUrl);

  const hosts = relayToHostsIds.get(relayUrl);
  if (hosts) {
    for (const hostId of hosts) {
      relayByHostId.delete(hostId);
    }

    relayToHostsIds.delete(relayUrl);
  }

  const clients = relayToClientIds.get(relayUrl);
  if (clients) {
    for (const clientId of clients) {
      relayByClientId.delete(clientId);
    }

    relayToClientIds.delete(relayUrl);
  }
}

/**
 * The relay URL a host is currently live on, or undefined if not connected to any
 * relay.
 */
export function getHostRelayUrl(hostId: string): string | undefined {
  return relayByHostId.get(hostId);
}

/**
 * Currently-connected hosts and clients, as reported by relays. Mirrors the old
 * `getSessionStats` `{hosts, clients}` shape, with a per-relay breakdown.
 */
export function getPresenceStats(): {
  hosts: number;
  clients: number;
  byRelay: Record<string, { hosts: number; clients: number }>;
} {
  const byRelay: Record<string, { hosts: number; clients: number }> = {};
  const bucket = (relayUrl: string) =>
    (byRelay[relayUrl] ??= { hosts: 0, clients: 0 });

  // Base the breakdown on the live fleet so every connected relay is listed,
  // even one with no hosts/clients yet.
  for (const relayUrl of liveRelayUrls) {
    bucket(relayUrl);
  }

  for (const [relayUrl, hosts] of relayToHostsIds) {
    bucket(relayUrl).hosts = hosts.size;
  }

  for (const [relayUrl, clients] of relayToClientIds) {
    bucket(relayUrl).clients = clients.size;
  }

  return {
    hosts: relayByHostId.size,
    clients: relayByClientId.size,
    byRelay,
  };
}
