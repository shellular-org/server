import { nanoid } from "nanoid";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { getHost } from "@/db";
import { logger } from "@/logger";
import {
	type ClientToHostMsg,
	ClientToHostMsgSchema,
	MsgType,
	type PongMsg,
	parseBaseMessage,
	type SessionClientJoinedMsg,
	type SessionClientLeftMsg,
	type SessionJoinedMsg,
	type SessionJoinMsg,
	SessionJoinMsgSchema,
} from "./protocol";
import {
	getActiveSessionForHost,
	getSessionForSocket,
	joinSession,
	removeSocket,
	type Session,
} from "./sessions";
import { sendSessionErrorToClient } from "./shared";

export function initAppWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });

	wsServer.on("connection", (ws: WebSocket) => {
		/**
		 * Session associated with this WebSocket connection.
		 * Only set after successful authentication. If null, the connection is not authenticated yet.
		 */
		let session: Session | null = null;

		ws.on("message", (raw) => {
			const rawStr = raw.toString();
			const parsedBaseMsg = parseBaseMessage(rawStr);
			if (!parsedBaseMsg) {
				sendSessionErrorToClient(ws, "Invalid message format");
				return;
			}

			if (parsedBaseMsg.type === MsgType.PING) {
				const pongId = `server_${nanoid(8)}`;
				const pongMsg: PongMsg = {
					type: MsgType.PONG,
					respTo: parsedBaseMsg.id,
				};
				ws.send(JSON.stringify({ id: pongId, ...pongMsg }));
				return;
			}

			if (!session) {
				const msg = SessionJoinMsgSchema.safeParse(parsedBaseMsg);
				if (!msg.success) {
					sendSessionErrorToClient(
						ws,
						`Received invalid message before authentication (got type: ${parsedBaseMsg.type})`,
						parsedBaseMsg.id,
						{
							rawStr,
							zodError: z.treeifyError(msg.error),
						},
					);
					return;
				}

				try {
					session = handleAuth(ws, msg.data);
				} catch (err) {
					sendSessionErrorToClient(
						ws,
						err instanceof Error
							? err.message
							: "Something went wrong during authentication",
						msg.data.id,
					);
				}

				return;
			}

			// client (app) -> host (CLI) routing
			const msg = ClientToHostMsgSchema.safeParse(parsedBaseMsg);
			if (!msg.success) {
				sendSessionErrorToClient(
					ws,
					`Received invalid message format (type: ${parsedBaseMsg.type})`,
					parsedBaseMsg.id,
					{
						rawStr,
						zodError: z.treeifyError(msg.error),
					},
				);
				return;
			}

			relayToCli(ws, msg.data);
		});

		ws.on("close", () => {
			const entry = getSessionForSocket(ws);
			if (entry && entry.role === "client" && entry.clientId) {
				// Notify CLI that client disconnected
				const { session, clientId } = entry;
				if (session.host) {
					const respMsg: SessionClientLeftMsg = {
						type: MsgType.SESSION_CLIENT_LEFT,
						data: { clientId },
					};
					session.host.send(
						JSON.stringify({
							id: `server_${nanoid(8)}`,
							...respMsg,
						}),
					);
				}
			}
			removeSocket(ws);
		});

		ws.on("error", () => removeSocket(ws));
	});

	logger.info("App WebSocketServer initialized");
	return wsServer;
}

function handleAuth(ws: WebSocket, msg: SessionJoinMsg): Session {
	const { connection: hostId, clientId, appVersion, platform } = msg.data;

	if (!hostId || !clientId) {
		throw new Error("Missing hostId or clientId");
	}

	const host = getHost(hostId);
	if (!host) {
		throw new Error("Trying to connect to non-existent host");
	}

	const session = getActiveSessionForHost(hostId);
	if (!session) {
		throw new Error("Host is not online");
	}

	const joined = joinSession(session.id, clientId, ws, appVersion, platform);
	if (!joined) {
		throw new Error("Failed to join session");
	}

	// complete handshake with the client (app)
	const joinedMsg: SessionJoinedMsg = {
		type: MsgType.SESSION_JOINED,
		respTo: msg.id,
		data: {
			...session.hostInfo,
			sessionId: session.id,
		},
	};
	ws.send(JSON.stringify({ id: `server_${nanoid(8)}`, ...joinedMsg }));

	// also notify the host (CLI) that a new client has joined
	const respMsg: SessionClientJoinedMsg = {
		type: MsgType.SESSION_CLIENT_JOINED,
		data: { clientId, appVersion, platform },
	};
	session.host.send(
		JSON.stringify({
			id: `server_${nanoid(8)}`,
			...respMsg,
		}),
	);

	return session;
}

function relayToCli(sender: WebSocket, msg: ClientToHostMsg) {
	const entry = getSessionForSocket(sender);
	if (!entry) {
		sendSessionErrorToClient(
			sender,
			"Client is not attached to a session",
			msg.id,
		);
		return;
	}

	if (entry.role !== "client") {
		logger.error("Received app message from a non-client socket");
		sendSessionErrorToClient(
			sender,
			"Only clients can send messages to host",
			msg.id,
		);
		return;
	}

	const { session, clientId } = entry;
	if (!session.host) {
		sendSessionErrorToClient(sender, "Host is not currently connected", msg.id);
		return;
	}

	// App → CLI, include clientId so CLI knows who sent it
	try {
		const msgWithClientId = JSON.stringify({
			...msg,
			clientId,
		});
		session.host.send(msgWithClientId);
	} catch (err) {
		logger.error("Failed to relay app message to CLI", err);
		sendSessionErrorToClient(sender, "Failed to relay message to host", msg.id);
	}
}
