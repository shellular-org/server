import type { WebSocket } from "ws";

export interface HttpClient {
	clientId: string;
	queue: string[];
	lastSeen: number;
}

export interface TerminalBuffer {
	data: string;
	updatedAt: number;
}

export interface Session {
	machineId: string;
	host: WebSocket;
	hostInfo: {
		hostname: string;
		platform: string;
		dir: string;
		machineId?: string;
	};
	clients: Set<WebSocket>;
	httpClients: Map<string, HttpClient>;
	terminalBuffers: Map<string, TerminalBuffer>;
}

const TERMINAL_BUFFER_MAX = 100 * 1024; // 100KB
const BUFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessions = new Map<string, Session>();
const socketToSession = new WeakMap<
	WebSocket,
	{ session: Session; role: "host" | "client" }
>();
const httpClientToSession = new Map<string, Session>();

export function createSession(
	machineId: string,
	host: WebSocket,
	hostInfo: Session["hostInfo"],
): Session {
	const session: Session = {
		machineId,
		host,
		hostInfo,
		clients: new Set(),
		httpClients: new Map(),
		terminalBuffers: new Map(),
	};
	sessions.set(machineId, session);
	socketToSession.set(host, { session, role: "host" });
	return session;
}

export function joinSession(
	machineId: string,
	client: WebSocket,
): Session | null {
	const session = sessions.get(machineId);
	if (!session) return null;
	session.clients.add(client);
	socketToSession.set(client, { session, role: "client" });
	return session;
}

export function joinSessionHttp(
	machineId: string,
	clientId: string,
): Session | null {
	const session = sessions.get(machineId);
	if (!session) return null;
	const httpClient: HttpClient = {
		clientId,
		queue: [],
		lastSeen: Date.now(),
	};
	session.httpClients.set(clientId, httpClient);
	httpClientToSession.set(clientId, session);
	return session;
}

export function getHttpClient(
	clientId: string,
): { session: Session; httpClient: HttpClient } | null {
	const session = httpClientToSession.get(clientId);
	if (!session) return null;
	const httpClient = session.httpClients.get(clientId);
	if (!httpClient) return null;
	httpClient.lastSeen = Date.now();
	return { session, httpClient };
}

export function pushToHttpClients(session: Session, rawMessage: string) {
	for (const [, httpClient] of session.httpClients) {
		httpClient.queue.push(rawMessage);
	}
}

export function removeHttpClient(clientId: string): void {
	const session = httpClientToSession.get(clientId);
	if (!session) return;
	session.httpClients.delete(clientId);
	httpClientToSession.delete(clientId);
}

export function rehostSession(
	machineId: string,
	newHost: WebSocket,
	hostInfo: Session["hostInfo"],
): Session | null {
	const session = sessions.get(machineId);
	if (!session) return null;
	// Remove old host mapping (old socket may already be dead)
	socketToSession.delete(session.host);
	// Update host
	session.host = newHost;
	session.hostInfo = hostInfo;
	socketToSession.set(newHost, { session, role: "host" });
	return session;
}

export function getSessionForSocket(ws: WebSocket) {
	return socketToSession.get(ws) ?? null;
}

export function removeSocket(ws: WebSocket): void {
	const entry = socketToSession.get(ws);
	if (!entry) return;

	const { session, role } = entry;
	socketToSession.delete(ws);

	if (role === "host") {
		// Notify all WS clients that host disconnected
		for (const client of session.clients) {
			try {
				client.send(
					JSON.stringify({
						type: "session:error",
						id: "0",
						error: "Host disconnected",
					}),
				);
				client.close();
			} catch {}
			socketToSession.delete(client);
		}
		// Notify HTTP polling clients
		const disconnectMsg = JSON.stringify({
			type: "session:error",
			id: "0",
			error: "Host disconnected",
		});
		pushToHttpClients(session, disconnectMsg);
		for (const [cid] of session.httpClients) {
			removeHttpClient(cid);
		}
		sessions.delete(session.machineId);
	} else {
		session.clients.delete(ws);
	}
}

export function getSession(machineId: string): Session | null {
	return sessions.get(machineId) ?? null;
}

export function appendTerminalBuffer(
	session: Session,
	terminalId: string,
	data: string,
): void {
	const existing = session.terminalBuffers.get(terminalId);
	let buf = existing ? existing.data + data : data;
	if (buf.length > TERMINAL_BUFFER_MAX) {
		buf = buf.slice(buf.length - TERMINAL_BUFFER_MAX);
	}
	session.terminalBuffers.set(terminalId, { data: buf, updatedAt: Date.now() });
}

export function getAndClearTerminalBuffer(
	session: Session,
	terminalId: string,
): string {
	const entry = session.terminalBuffers.get(terminalId);
	if (!entry) return "";
	session.terminalBuffers.delete(terminalId);
	return entry.data;
}

export function removeTerminalBuffer(
	session: Session,
	terminalId: string,
): void {
	session.terminalBuffers.delete(terminalId);
}

export function cleanupStaleBuffers(): void {
	const now = Date.now();
	for (const [, session] of sessions) {
		for (const [tid, buf] of session.terminalBuffers) {
			if (now - buf.updatedAt > BUFFER_TTL_MS) {
				session.terminalBuffers.delete(tid);
			}
		}
	}
}
