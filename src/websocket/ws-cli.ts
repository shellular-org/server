import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

import { logger } from "logger";
import {
	appendTerminalBuffer,
	canReuseSessionId,
	createSession,
	generateSessionId,
	getSessionForSocket,
	rehostSession,
	removeSocket,
	removeTerminalBuffer,
} from "./sessions";
import {
	CliRelayMsgSchema,
	MsgType,
	PingMsgSchema,
	SessionHostMsgSchema,
	type PongMsg,
	type SessionErrorMsg,
	type SessionHostedMsg,
	parseMessage,
} from "./protocol";

export function initCliWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });
	wsServer.on("connection", (ws: WebSocket) => {
		let authenticated = false;

		ws.on("message", (raw) => {
			const rawStr = raw.toString();
			const pingMsg = parseMessage(rawStr, PingMsgSchema);
			if (pingMsg) {
				try {
					const pongId = "pong_" + nanoid();
					const respMsg: PongMsg = {
						type: MsgType.PONG,
						respTo: pingMsg.id,
					};
					ws.send(JSON.stringify({ id: pongId, ...respMsg }));
				} catch {}
				return;
			}

			if (!authenticated) {
				const msg = parseMessage(rawStr, SessionHostMsgSchema);
				if (!msg) {
					const id = "err_" + nanoid();
					const respMsg: SessionErrorMsg = {
						type: MsgType.SESSION_ERROR,
						error: "Invalid message format",
					};
					ws.send(JSON.stringify({ id, ...respMsg }));
					return;
				}
				handleAuth(ws, msg);
				if (getSessionForSocket(ws)) {
					authenticated = true;
				}
				return;
			}

			// CLI → App routing
			const msg = parseMessage(rawStr, CliRelayMsgSchema);
			if (!msg) {
				const id = "err_" + nanoid();
				const respMsg: SessionErrorMsg = {
					type: MsgType.SESSION_ERROR,
					error: "Invalid message format",
				};
				ws.send(JSON.stringify({ id, ...respMsg }));
				return;
			}
			relayToApp(ws, rawStr, msg);
		});

		ws.on("close", () => {
			const entry = getSessionForSocket(ws);
			if (entry && entry.role === "host") {
				// Notify all clients that CLI disconnected
				const { session } = entry;
				for (const [, clientInfo] of session.clients) {
					try {
						const respMsg: SessionErrorMsg = {
							type: MsgType.SESSION_ERROR,
							error: "Host disconnected",
						};
						clientInfo.ws.send(
							JSON.stringify({
								id: "err_" + nanoid(),
								...respMsg,
							}),
						);
						clientInfo.ws.close();
					} catch {}
				}
			}
			removeSocket(ws);
		});

		ws.on("error", () => removeSocket(ws));
	});

	logger.info("CLI WebSocketServer initialized");
	return wsServer;
}

function sendSessionError(ws: WebSocket, error: string, respTo?: string) {
	const errorId = "err_" + nanoid();
	const respMsg: SessionErrorMsg = {
		type: MsgType.SESSION_ERROR,
		respTo,
		error,
	};
	ws.send(JSON.stringify({ id: errorId, ...respMsg }));
}

function handleAuth(ws: WebSocket, msg: any) {
	if (msg.type === MsgType.SESSION_HOST) {
		const {
			machineId,
			hostname,
			platform,
			dir,
			sessionId: requestedSessionId,
		} = msg.data;

		if (!machineId) {
			const errorId = "err_" + nanoid();
			const respMsg: SessionErrorMsg = {
				type: MsgType.SESSION_ERROR,
				respTo: msg.id,
				error: "Missing machineId",
			};
			ws.send(JSON.stringify({ id: errorId, ...respMsg }));
			return;
		}

		const hostInfo = { hostname, platform, dir, machineId };
		let sessionId = requestedSessionId;

		if (sessionId && canReuseSessionId(sessionId, machineId)) {
			rehostSession(sessionId, ws, hostInfo);
		} else {
			sessionId = generateSessionId();
			createSession(sessionId, machineId, ws, hostInfo);
		}

		const hostedId = "hosted_" + nanoid();
		const respMsg: SessionHostedMsg = {
			type: MsgType.SESSION_HOSTED,
			respTo: msg.id,
			data: { sessionId },
		};
		ws.send(JSON.stringify({ id: hostedId, ...respMsg }));
	} else if (msg.type === MsgType.PING) {
		const pongId = "pong_" + nanoid();
		const respMsg: PongMsg = {
			type: MsgType.PONG,
			respTo: msg.id,
		};
		ws.send(JSON.stringify({ id: pongId, ...respMsg }));
	} else {
		const errorId = "err_" + nanoid();
		const respMsg: SessionErrorMsg = {
			type: MsgType.SESSION_ERROR,
			respTo: msg.id,
			error: "Must send session:host first",
		};
		ws.send(JSON.stringify({ id: errorId, ...respMsg }));
	}
}

function relayToApp(
	sender: WebSocket,
	rawMessage: string,
	parsedMsg: { id: string; clientId: string; type: string },
) {
	const entry = getSessionForSocket(sender);
	if (!entry) {
		sendSessionError(sender, "Host is not attached to a session", parsedMsg.id);
		return;
	}

	const { session } = entry;
	let parsed: { id?: string; clientId?: string; type?: string; data?: any };
	try {
		parsed = JSON.parse(rawMessage);
	} catch {
		sendSessionError(sender, "Invalid message format", parsedMsg.id);
		return;
	}

	const clientId = parsed.clientId;

	if (!clientId) {
		logger.error("CLI message missing clientId");
		sendSessionError(
			sender,
			"Client routing information is missing",
			parsed.id,
		);
		return;
	}

	// Intercept terminal:data to accumulate server-side buffer
	if (parsed.type === MsgType.TERMINAL_DATA && parsed.data?.terminalId) {
		appendTerminalBuffer(
			session,
			clientId,
			parsed.data.terminalId,
			parsed.data.data ?? "",
		);
	} else if (
		parsed.type === MsgType.TERMINAL_CLOSE &&
		parsed.data?.terminalId
	) {
		removeTerminalBuffer(session, clientId, parsed.data.terminalId);
	}

	// CLI → specific App client
	const clientInfo = session.clients.get(clientId);
	if (!clientInfo) {
		sendSessionError(sender, `Client ${clientId} is not connected`, parsed.id);
		return;
	}

	try {
		const { clientId: _clientId, ...msgForApp } = parsed;
		clientInfo.ws.send(JSON.stringify(msgForApp));
	} catch (err) {
		logger.error("Failed to relay CLI message to app", err);
		sendSessionError(
			sender,
			`Failed to relay message to client ${clientId}`,
			parsed.id,
		);
	}
}
