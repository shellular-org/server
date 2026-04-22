import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import { sleep } from "@/utils";
import { MsgType } from "./protocol";

export interface ClientInfo {
	ws: WebSocket;
	appVersion: string;
	platform: string;
	clientId: string;
}

export type SocketRole = "host" | "client";

type SocketInfo = {
	session: Session;
} & ({ role: "host" } | { role: "client"; clientId: string });

export interface Session {
	id: string;
	hostId: string;
	host: WebSocket;
	hostInfo: {
		hostname: string;
		platform: string;
		dir: string;
		machineId: string;
	};
	clients: Map<string, ClientInfo>;
}

const sessions = new Map<string, Session>();
const socketToSession = new WeakMap<WebSocket, SocketInfo>();

export function createSession(
	hostId: string,
	host: WebSocket,
	hostInfo: Session["hostInfo"],
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
	client: {
		id: string;
		ws: WebSocket;
		appVersion: string;
		platform: string;
	},
): Session | null {
	const session = sessions.get(sessionId);
	if (!session?.host) {
		return null;
	}
	const clientInfo: ClientInfo = {
		ws: client.ws,
		appVersion: client.appVersion,
		platform: client.platform,
		clientId: client.id,
	};
	session.clients.set(client.id, clientInfo);
	socketToSession.set(client.ws, {
		session,
		role: "client",
		clientId: client.id,
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
			clientInfo.ws.close();
			socketToSession.delete(clientInfo.ws);
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
