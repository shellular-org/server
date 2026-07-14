import { CloseCodeAndReason } from "@relay/websocket/shared";
import {
  type ClientInfo,
  type HostInfo,
  MsgType,
  type SessionClientLeftMsg,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";

export interface ClientInfoWithWebSocket {
  ws: WebSocket;
  info: ClientInfo;
}

export type SocketRole = "host" | "client";

type SocketInfo = {
  session: Session;
} & ({ role: "host" } | { role: "client"; clientId: string });

/**
 * Dynamic CLI update status, re-checked by the host on each client approval.
 * Kept off `hostInfo` (which is stable host identity) because it changes over a
 * long-lived session as new versions are published.
 */
interface SessionUpdateInfo {
  updateAvailable?: boolean;
  latestCliVersion?: string;
}

export interface Session {
  id: string;
  hostId: string;
  host: WebSocket;
  hostInfo: HostInfo;
  updateInfo: SessionUpdateInfo;
  clients: Map<string, ClientInfoWithWebSocket>;
}

type ConnectionTracker = {
  hosts: Set<string>;
  clients: Set<string>;
};

const sessions = new Map<string, Session>();
const sessionsByHostId = new Map<string, Session>();
const socketToSession = new WeakMap<WebSocket, SocketInfo>();
const connections: ConnectionTracker = {
  hosts: new Set(),
  clients: new Set(),
};

export function createSession(
  hostId: string,
  host: WebSocket,
  hostInfo: HostInfo,
): Session {
  const session: Session = {
    id: nanoid(8),
    hostId,
    host,
    hostInfo,
    updateInfo: {},
    clients: new Map(),
  };
  sessions.set(session.id, session);
  sessionsByHostId.set(hostId, session);
  connections.hosts.add(hostId);
  socketToSession.set(host, { session, role: "host" });
  return session;
}

export function joinSession(
  sessionId: string,
  clientWs: WebSocket,
  clientInfo: ClientInfo,
): Session | null {
  const session = sessions.get(sessionId);
  if (!session?.host) {
    return null;
  }

  const clientInfoWithWs: ClientInfoWithWebSocket = {
    ws: clientWs,
    info: clientInfo,
  };

  const existingClient = session.clients.get(clientInfo.clientId);
  if (existingClient && existingClient.ws !== clientWs) {
    socketToSession.delete(existingClient.ws);
    const { code, reason } = CloseCodeAndReason.CLIENT_REPLACED;
    existingClient.ws.close(code, reason);
  }

  connections.clients.add(clientInfo.clientId);
  session.clients.set(clientInfo.clientId, clientInfoWithWs);
  socketToSession.set(clientWs, {
    session,
    role: "client",
    clientId: clientInfo.clientId,
  });
  return session;
}

export function removeClient(sessionId: string, clientId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  const clientInfo = session.clients.get(clientId);
  if (!clientInfo) {
    return;
  }

  session.clients.delete(clientId);
  socketToSession.delete(clientInfo.ws);
  connections.clients.delete(clientId);
}

export function getActiveSessionForHost(hostId: string): Session | null {
  return sessionsByHostId.get(hostId) ?? null;
}

/** All currently-connected host sessions, for periodic sweeps (e.g. analytics). */
export function getActiveHostSessions(): Session[] {
  return [...sessionsByHostId.values()];
}

export function getSessionStats() {
  return {
    hosts: connections.hosts.size,
    clients: connections.clients.size,
  };
}

export function getSessionForSocket(ws: WebSocket) {
  return socketToSession.get(ws) ?? null;
}

export function removeSocket(ws: WebSocket) {
  const entry = socketToSession.get(ws);
  if (!entry) {
    return;
  }

  socketToSession.delete(ws);

  if (entry.role === "host") {
    // Close all WS clients that with host disconnected code
    connections.hosts.delete(entry.session.hostId);
    for (const [, clientInfo] of entry.session.clients) {
      const { code, reason } = CloseCodeAndReason.HOST_DISCONNECTED;
      clientInfo.ws.close(code, reason);
      socketToSession.delete(clientInfo.ws);
      connections.clients.delete(clientInfo.info.clientId);
    }
    entry.session.clients.clear();
    sessions.delete(entry.session.id);
    sessionsByHostId.delete(entry.session.hostId);
  } else if (entry.role === "client") {
    // Client disconnected
    const clientInfo = entry.session.clients.get(entry.clientId);
    if (clientInfo && clientInfo.ws === ws) {
      entry.session.clients.delete(entry.clientId);
      connections.clients.delete(entry.clientId);

      // Notify host/CLI that client disconnected
      const respMsg: SessionClientLeftMsg = {
        type: MsgType.SESSION_CLIENT_LEFT,
        data: { clientId: entry.clientId },
      };
      entry.session.host.send(
        JSON.stringify({
          id: `server_${nanoid(8)}`,
          ...respMsg,
        }),
      );
    }
  }
}
