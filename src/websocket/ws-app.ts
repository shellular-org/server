import { type WebSocket, WebSocketServer } from "ws";
import { nanoid } from "nanoid";

import { logger } from "logger";
import {
	getSession,
	getSessionForSocket,
	getSessionsByMachineId,
	joinSession,
	removeSocket,
} from "./sessions";
import type { Session } from "./sessions";
import {
	AppRelayMsgSchema,
	MsgType,
	SessionJoinMsgSchema,
	type SessionClientJoinedMsg,
	type SessionClientLeftMsg,
	type SessionErrorMsg,
	type SessionJoinedMsg,
	parseMessage,
} from "./protocol";

export function initAppWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });

	wsServer.on("connection", (ws: WebSocket) => {
		let authenticated = false;

		ws.on("message", (raw) => {
			const rawStr = raw.toString();

			if (!authenticated) {
				const msg = parseMessage(rawStr, SessionJoinMsgSchema);
				if (!msg) {
					sendSessionError(ws, "Invalid message format");
					return;
				}
				handleAuth(ws, msg);
				if (getSessionForSocket(ws)) {
					authenticated = true;
				}
				return;
			}

			// App → CLI routing
			const msg = parseMessage(rawStr, AppRelayMsgSchema);
			if (!msg) {
				sendSessionError(ws, "Invalid message format");
				return;
			}
			relayToCli(ws, rawStr, msg.id);
		});

		ws.on("close", () => {
			const entry = getSessionForSocket(ws);
			if (entry && entry.role === "client" && entry.clientId) {
				// Notify CLI that client disconnected
				const { session, clientId } = entry;
				try {
					const respMsg: SessionClientLeftMsg = {
						type: MsgType.SESSION_CLIENT_LEFT,
						data: { clientId },
					};
					session.host.send(
						JSON.stringify({
							id: "evt_" + nanoid(),
							...respMsg,
						}),
					);
				} catch {}
			}
			removeSocket(ws);
		});

		ws.on("error", () => removeSocket(ws));
	});

	logger.info("App WebSocketServer initialized");
	return wsServer;
}

function sendSessionError(
	ws: WebSocket,
	error: string,
	respTo?: string,
) {
	const errorId = "err_" + nanoid();
	const respMsg: SessionErrorMsg = {
		type: MsgType.SESSION_ERROR,
		respTo,
		error,
	};
	ws.send(JSON.stringify({ id: errorId, ...respMsg }));
}

function handleAuth(ws: WebSocket, msg: any) {
	if (msg.type === MsgType.SESSION_JOIN) {
		const { connection, clientId, appVersion, platform } = msg.data;

		if (!connection || !clientId) {
			const errorId = "err_" + nanoid();
			const respMsg: SessionErrorMsg = {
				type: MsgType.SESSION_ERROR,
				respTo: msg.id,
				error: "Missing connection or clientId",
			};
			ws.send(JSON.stringify({ id: errorId, ...respMsg }));
			return;
		}

		let session: Session | null = null;
		let connectionId: string = "";

		if (connection.includes(":")) {
			const [machineId, connId] = connection.split(":");
			session = getSession(connId);
			if (session && session.machineId === machineId) {
				connectionId = connId;
			} else {
				session = null;
			}
		} else {
			const machineId = connection;
			const machineSessions = getSessionsByMachineId(machineId);
			if (machineSessions.length > 0) {
				session = machineSessions[0];
				connectionId = session.connectionId;
			}
		}

		if (!session) {
			const errorId = "err_" + nanoid();
			const respMsg: SessionErrorMsg = {
				type: MsgType.SESSION_ERROR,
				respTo: msg.id,
				error: "No available session for this device",
			};
			ws.send(JSON.stringify({ id: errorId, ...respMsg }));
			return;
		}

		const joined = joinSession(
			connectionId,
			clientId,
			ws,
			appVersion,
			platform,
		);
		if (!joined) {
			const errorId = "err_" + nanoid();
			const respMsg: SessionErrorMsg = {
				type: MsgType.SESSION_ERROR,
				respTo: msg.id,
				error: "Failed to join session",
			};
			ws.send(JSON.stringify({ id: errorId, ...respMsg }));
			return;
		}

		// Notify client of host info with connection ID
		const joinedId = "joined_" + nanoid();
		const joinedMsg: SessionJoinedMsg = {
			type: MsgType.SESSION_JOINED,
			respTo: msg.id,
			data: {
				...session.hostInfo,
				connectionId,
			},
		};
		ws.send(JSON.stringify({ id: joinedId, ...joinedMsg }));
		// Notify CLI that a client joined with client details
		try {
			const respMsg: SessionClientJoinedMsg = {
				type: MsgType.SESSION_CLIENT_JOINED,
				data: { clientId, appVersion, platform },
			};
			session.host.send(
				JSON.stringify({
					id: "evt_" + nanoid(),
					...respMsg,
				}),
			);
		} catch {}
	} else {
		const errorId = "err_" + nanoid();
		const respMsg: SessionErrorMsg = {
			type: MsgType.SESSION_ERROR,
			respTo: msg.id,
			error: "Must send session:join first",
		};
		ws.send(JSON.stringify({ id: errorId, ...respMsg }));
	}
}

function relayToCli(sender: WebSocket, rawMessage: string, msgId?: string) {
	const entry = getSessionForSocket(sender);
	if (!entry) {
		sendSessionError(sender, "Client is not attached to a session", msgId);
		return;
	}

	const { session, clientId } = entry;
	let parsed: { id?: string } & Record<string, unknown>;

	try {
		parsed = JSON.parse(rawMessage);
	} catch {
		sendSessionError(sender, "Invalid message format", msgId);
		return;
	}

	if (!clientId) {
		logger.error("App message missing clientId");
		sendSessionError(
			sender,
			"Client routing information is missing",
			parsed.id,
		);
		return;
	}

	// App → CLI, include clientId so CLI knows who sent it
	try {
		const msgWithClientId = JSON.stringify({ ...parsed, clientId });
		session.host.send(msgWithClientId);
	} catch (err) {
		logger.error("Failed to relay app message to CLI", err);
		sendSessionError(
			sender,
			"Failed to relay message to host",
			parsed.id,
		);
	}
}
