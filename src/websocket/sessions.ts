import { type ClientInfo, type HostInfo, MsgType } from "@shellular/protocol";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";

import { sleep } from "@/utils";
import { CloseCodeAndReason } from "./shared";

export interface ClientInfoWithWebSocket {
	ws: WebSocket;
	info: ClientInfo;
}

export type SocketRole = "host" | "client";

type SocketInfo = {
	session: Session;
} & ({ role: "host" } | { role: "client"; clientId: string });

export interface Session {
	id: string;
	hostId: string;
	host: WebSocket;
	hostInfo: HostInfo;
	clients: Map<string, ClientInfoWithWebSocket>;
}

const sessions = new Map<string, Session>();
const socketToSession = new WeakMap<WebSocket, SocketInfo>();

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
		clients: new Map(),
	};
	sessions.set(session.id, session);
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
	if (!session) return;
	const clientInfo = session.clients.get(clientId);
	if (!clientInfo) return;

	session.clients.delete(clientId);
	socketToSession.delete(clientInfo.ws);
}

export function getActiveSessionForHost(hostId: string): Session | null {
	for (const session of sessions.values()) {
		if (session.hostId === hostId) {
			return session;
		}
	}
	return null;
}

export function getSessionForSocket(ws: WebSocket) {
	return socketToSession.get(ws) ?? null;
}

export async function removeSocket(ws: WebSocket) {
	const entry = socketToSession.get(ws);
	if (!entry) {
		return;
	}

	socketToSession.delete(ws);

	if (entry.role === "host") {
		// Notify all WS clients that host disconnected
		for (const [, clientInfo] of entry.session.clients) {
			clientInfo.ws.send(
				JSON.stringify({
					type: MsgType.SESSION_ERROR,
					id: `server_${nanoid(8)}`,
					error: "Host disconnected",
				}),
			);
			await sleep(250); // Give client a moment to receive message before closing
			const { code, reason } = CloseCodeAndReason.HOST_DISCONNECTED;
			clientInfo.ws.close(code, reason);
			socketToSession.delete(ws);
		}
		entry.session.clients.clear();
		sessions.delete(entry.session.id);
	} else if (entry.role === "client") {
		// Client disconnected
		const clientInfo = entry.session.clients.get(entry.clientId);
		if (clientInfo && clientInfo.ws === ws) {
			entry.session.clients.delete(entry.clientId);
		}
	}
}
