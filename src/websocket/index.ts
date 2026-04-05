import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { WebSocket } from "ws";

const { Server: WSServer } = require("ws");

import {
	appendTerminalBuffer,
	createSession,
	getSession,
	getSessionForSocket,
	joinSession,
	pushToHttpClients,
	rehostSession,
	removeSocket,
	removeTerminalBuffer,
} from "./sessions";

const PING_INTERVAL_MS = 30_000;

export function initWebSocket(server: HttpServer) {
	const wss = new WSServer({ server });

	// Ping all connected sockets periodically to keep connections alive
	// through reverse proxies and load balancers
	const aliveSet = new WeakSet<WebSocket>();

	wss.on("connection", (ws: WebSocket) => {
		aliveSet.add(ws);

		// biome-ignore lint/suspicious/noExplicitAny: ws library pong event not on base type
		(ws as any).on("pong", () => {
			aliveSet.add(ws);
		});

		// First message must be session:host or session:join
		let authenticated = false;

		ws.on("message", (raw) => {
			let msg: { type: string; id: string; data?: Record<string, unknown> };
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				ws.send(
					JSON.stringify({ type: "error", id: "0", error: "Invalid JSON" }),
				);
				return;
			}

			// Application-level ping — respond with pong
			if (msg.type === "ping") {
				try {
					ws.send(JSON.stringify({ type: "pong", id: msg.id }));
				} catch {}
				return;
			}

			if (!authenticated) {
				handleAuth(ws, msg);
				if (getSessionForSocket(ws)) {
					authenticated = true;
				}
				return;
			}

			// Relay message to the other side
			relay(ws, raw.toString());
		});

		ws.on("close", () => removeSocket(ws));
		ws.on("error", () => removeSocket(ws));
	});

	// Periodic ping to detect dead connections and keep proxies happy
	setInterval(() => {
		for (const ws of wss.clients) {
			if (!aliveSet.has(ws as WebSocket)) {
				(ws as WebSocket).terminate();
				continue;
			}
			aliveSet.delete(ws as WebSocket);
			try {
				// biome-ignore lint/suspicious/noExplicitAny: ws library ping not on base type
				(ws as any).ping();
			} catch {}
		}
	}, PING_INTERVAL_MS);

	console.info("WebSocket server initialized");
	return wss;
}

function handleAuth(
	ws: WebSocket,
	msg: { type: string; id: string; data?: Record<string, unknown> },
) {
	if (msg.type === "session:host") {
		const data = msg.data ?? {};
		const hostInfo = {
			hostname: String(data.hostname ?? "unknown"),
			platform: String(data.platform ?? "unknown"),
			dir: String(data.dir ?? "."),
		};

		// Support re-hosting: if CLI provides its old token, reuse the session
		const requestedToken = data.token ? String(data.token) : null;
		let token: string;

		if (requestedToken && getSession(requestedToken)) {
			rehostSession(requestedToken, ws, hostInfo);
			token = requestedToken;
		} else {
			token = randomUUID().slice(0, 8);
			createSession(token, ws, hostInfo);
		}

		ws.send(
			JSON.stringify({ type: "session:hosted", id: msg.id, data: { token } }),
		);
	} else if (msg.type === "session:join") {
		const token = String(msg.data?.token ?? "");
		const session = joinSession(token, ws);
		if (!session) {
			ws.send(
				JSON.stringify({
					type: "session:error",
					id: msg.id,
					error: "Invalid session token",
				}),
			);
			return;
		}
		// Notify client of host info
		ws.send(
			JSON.stringify({
				type: "session:joined",
				id: msg.id,
				data: session.hostInfo,
			}),
		);
		// Notify host that a client joined
		try {
			session.host.send(
				JSON.stringify({ type: "session:client-joined", id: msg.id, data: {} }),
			);
		} catch {}
	} else {
		ws.send(
			JSON.stringify({
				type: "error",
				id: msg.id ?? "0",
				error: "Must send session:host or session:join first",
			}),
		);
	}
}

function relay(sender: WebSocket, rawMessage: string) {
	const entry = getSessionForSocket(sender);
	if (!entry) return;

	const { session, role } = entry;
	if (role === "host") {
		// Intercept terminal:data to accumulate server-side buffer
		try {
			const parsed = JSON.parse(rawMessage);
			if (parsed.type === "terminal:data" && parsed.data?.terminalId) {
				appendTerminalBuffer(
					session,
					parsed.data.terminalId,
					parsed.data.data ?? "",
				);
			} else if (parsed.type === "terminal:closed" && parsed.data?.terminalId) {
				removeTerminalBuffer(session, parsed.data.terminalId);
			}
		} catch {}

		// Host → all WS clients
		for (const client of session.clients) {
			try {
				client.send(rawMessage);
			} catch {}
		}
		// Host → all HTTP polling clients
		pushToHttpClients(session, rawMessage);
	} else {
		// Client → host
		try {
			session.host.send(rawMessage);
		} catch {}
	}
}
