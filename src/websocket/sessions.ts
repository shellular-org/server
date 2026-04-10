import type { WebSocket } from "ws";
import { nanoid } from "nanoid";

export interface TerminalBuffer {
	data: string;
	updatedAt: number;
}

export interface ClientInfo {
	ws: WebSocket;
	appVersion: string;
	platform: string;
	clientId: string;
}

export type SocketRole = "host" | "client";

export interface SocketInfo {
	session: Session;
	role: SocketRole;
	clientId?: string;
}

export interface Session {
	sessionId: string;
	machineId: string;
	host: WebSocket | null;
	hostInfo: {
		hostname: string;
		platform: string;
		dir: string;
		machineId?: string;
	};
	clients: Map<string, ClientInfo>;
	terminalBuffers: Map<string, Map<string, TerminalBuffer>>;
	hostActive: boolean;
}

const TERMINAL_BUFFER_MAX = 100 * 1024; // 100KB
const BUFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessions = new Map<string, Session>();
const socketToSession = new WeakMap<WebSocket, SocketInfo>();

export function generateSessionId(): string {
	return nanoid(8);
}

export function createSession(
	sessionId: string,
	machineId: string,
	host: WebSocket,
	hostInfo: Session["hostInfo"],
): Session {
	const session: Session = {
		sessionId,
		machineId,
		host,
		hostInfo,
		clients: new Map(),
		terminalBuffers: new Map(),
		hostActive: true,
	};
	sessions.set(sessionId, session);
	socketToSession.set(host, { session, role: "host" });
	return session;
}

export function joinSession(
	sessionId: string,
	clientId: string,
	client: WebSocket,
	appVersion: string,
	platform: string,
): Session | null {
	const session = sessions.get(sessionId);
	if (!session || !session.host || !session.hostActive) return null;
	const clientInfo: ClientInfo = {
		ws: client,
		appVersion,
		platform,
		clientId,
	};
	session.clients.set(clientId, clientInfo);
	socketToSession.set(client, { session, role: "client", clientId });
	return session;
}

export function removeClient(sessionId: string, clientId: string): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	const clientInfo = session.clients.get(clientId);
	if (!clientInfo) return;

	session.clients.delete(clientId);
	socketToSession.delete(clientInfo.ws);

	// Clean up terminal buffers for this client
	session.terminalBuffers.delete(clientId);
}

export function rehostSession(
	sessionId: string,
	newHost: WebSocket,
	hostInfo: Session["hostInfo"],
): Session | null {
	const session = sessions.get(sessionId);
	if (!session || session.hostActive) return null;
	// Remove old host mapping (old socket may already be dead)
	if (session.host) {
		socketToSession.delete(session.host);
	}
	// Update host
	session.host = newHost;
	session.hostInfo = hostInfo;
	session.hostActive = true;
	socketToSession.set(newHost, { session, role: "host" });
	return session;
}

export function canReuseSessionId(
	sessionId: string,
	machineId: string,
): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	return session.machineId === machineId && !session.hostActive;
}

export function getSessionForSocket(ws: WebSocket) {
	return socketToSession.get(ws) ?? null;
}

export function removeSocket(ws: WebSocket): void {
	const entry = socketToSession.get(ws);
	if (!entry) return;

	const { session, role, clientId } = entry;
	socketToSession.delete(ws);

	if (role === "host") {
		// Notify all WS clients that host disconnected
		for (const [clientId, clientInfo] of session.clients) {
			try {
				clientInfo.ws.send(
					JSON.stringify({
						type: "session:error",
						id: "0",
						error: "Host disconnected",
					}),
				);
				clientInfo.ws.close();
			} catch {}
			socketToSession.delete(clientInfo.ws);
		}
		session.clients.clear();
		session.host = null;
		session.hostActive = false;
	} else if (role === "client" && clientId) {
		// Client disconnected
		const clientInfo = session.clients.get(clientId);
		if (clientInfo && clientInfo.ws === ws) {
			session.clients.delete(clientId);
			session.terminalBuffers.delete(clientId);
		}
	}
}

export function getSession(sessionId: string): Session | null {
	return sessions.get(sessionId) ?? null;
}

export function getSessionsByMachineId(machineId: string): Session[] {
	const result: Session[] = [];
	for (const session of sessions.values()) {
		if (session.machineId === machineId) {
			result.push(session);
		}
	}
	return result;
}

export function appendTerminalBuffer(
	session: Session,
	clientId: string,
	terminalId: string,
	data: string,
): void {
	if (!session.terminalBuffers.has(clientId)) {
		session.terminalBuffers.set(clientId, new Map());
	}
	const clientBuffers = session.terminalBuffers.get(clientId)!;
	const existing = clientBuffers.get(terminalId);
	let buf = existing ? existing.data + data : data;
	if (buf.length > TERMINAL_BUFFER_MAX) {
		buf = buf.slice(buf.length - TERMINAL_BUFFER_MAX);
	}
	clientBuffers.set(terminalId, { data: buf, updatedAt: Date.now() });
}

export function getAndClearTerminalBuffer(
	session: Session,
	clientId: string,
	terminalId: string,
): string {
	const clientBuffers = session.terminalBuffers.get(clientId);
	if (!clientBuffers) return "";
	const entry = clientBuffers.get(terminalId);
	if (!entry) return "";
	clientBuffers.delete(terminalId);
	return entry.data;
}

export function removeTerminalBuffer(
	session: Session,
	clientId: string,
	terminalId: string,
): void {
	const clientBuffers = session.terminalBuffers.get(clientId);
	if (!clientBuffers) return;
	clientBuffers.delete(terminalId);
}

export function cleanupStaleBuffers(): void {
	const now = Date.now();
	for (const [, session] of sessions) {
		for (const [clientId, clientBuffers] of session.terminalBuffers) {
			for (const [terminalId, buf] of clientBuffers) {
				if (now - buf.updatedAt > BUFFER_TTL_MS) {
					clientBuffers.delete(terminalId);
				}
			}
			if (clientBuffers.size === 0) {
				session.terminalBuffers.delete(clientId);
			}
		}
	}
}
