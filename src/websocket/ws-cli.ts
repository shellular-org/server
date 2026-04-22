import { nanoid } from "nanoid";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { verifyHost } from "@/db";
import { logger } from "@/logger";
import { sleep } from "@/utils";
import {
	type HostToClientMsg,
	HostToClientMsgSchema,
	MsgType,
	type PongMsg,
	parseBaseMessage,
	type SessionHostedMsg,
	type SessionHostMsg,
	SessionHostMsgSchema,
} from "./protocol";
import {
	createSession,
	getActiveSessionForHost,
	getSessionForSocket,
	removeSocket,
	type Session,
} from "./sessions";
import { sendSessionErrorToClient, sendSessionErrorToHost } from "./shared";

export function initCliWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });
	wsServer.on("connection", (ws) => {
		/**
		 * Session associated with this WebSocket connection.
		 * Only set after successful authentication. If null, the connection is not authenticated yet.
		 */
		let session: Session | null = null;

		ws.on("message", (raw) => {
			const rawStr = raw.toString();

			const parsedBaseMsg = parseBaseMessage(rawStr);
			if (!parsedBaseMsg) {
				sendSessionErrorToHost(ws, "Received invalid message format", {
					rawStr,
				});
				return;
			}

			if (parsedBaseMsg.type === MsgType.PING) {
				const pongId = `server_${nanoid(8)}`;
				const respMsg: PongMsg = {
					type: MsgType.PONG,
					respTo: parsedBaseMsg.id,
				};
				ws.send(JSON.stringify({ id: pongId, ...respMsg }));
				return;
			}

			if (!session) {
				const msg = SessionHostMsgSchema.safeParse(parsedBaseMsg);
				if (!msg.success) {
					sendSessionErrorToHost(
						ws,
						`Received invalid message before authentication (got type: ${parsedBaseMsg.type})`,
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
					sendSessionErrorToHost(
						ws,
						err instanceof Error
							? err.message
							: "Something went wrong during authentication",
					);
				}

				return;
			}

			// host (CLI) -> client (app) routing
			const msg = HostToClientMsgSchema.safeParse(parsedBaseMsg);
			if (!msg.success) {
				sendSessionErrorToHost(
					ws,
					`Received invalid message format (type: ${parsedBaseMsg.type})`,
					{
						rawStr,
						zodError: z.treeifyError(msg.error),
					},
				);
				return;
			}

			relayToApp(ws, msg.data);
		});

		ws.on("close", async () => {
			const entry = getSessionForSocket(ws);
			if (entry && entry.role === "host") {
				// Notify all clients that CLI disconnected
				const { session } = entry;
				for (const [, clientInfo] of session.clients) {
					sendSessionErrorToClient(clientInfo.ws, "Host disconnected");
					await sleep(100); // Give client a moment to receive message before closing
					clientInfo.ws.close();
				}
			}

			removeSocket(ws);
		});

		ws.on("error", () => removeSocket(ws));
	});

	logger.info("CLI WebSocketServer initialized");
	return wsServer;
}

function handleAuth(ws: WebSocket, msg: SessionHostMsg): Session {
	const { id: hostId, machineId, hostname, platform, dir } = msg.data;

	if (!hostId || !machineId || !platform) {
		throw new Error("Missing hostId, machineId, or platform");
	}

	const host = verifyHost(hostId, machineId, platform);
	if (!host) {
		throw new Error("Unknown host");
	}

	if (host.machineId !== machineId) {
		throw new Error(
			"Suspicious host: Machine ID is different from the registered one",
		);
	}

	const hostInfo = { hostname, platform, dir, machineId };

	const existing = getActiveSessionForHost(hostId);
	if (existing) {
		throw new Error("Host already has an active connection");
	}

	const session = createSession(hostId, ws, hostInfo);

	// complete handshake with the host (CLI)
	const hostedId = `server_${nanoid(8)}`;
	const respMsg: SessionHostedMsg = {
		type: MsgType.SESSION_HOSTED,
		data: { sessionId: session.id },
	};
	ws.send(JSON.stringify({ id: hostedId, ...respMsg }));

	return session;
}

function relayToApp(sender: WebSocket, msg: HostToClientMsg) {
	const entry = getSessionForSocket(sender);
	if (!entry) {
		sendSessionErrorToHost(sender, "Host is not attached to a session");
		return;
	}

	const { session } = entry;
	const clientId = msg.clientId;

	const clientInfo = session.clients.get(clientId);
	if (!clientInfo) {
		sendSessionErrorToHost(sender, `Client ${clientId} is not connected`);
		return;
	}

	try {
		clientInfo.ws.send(JSON.stringify(msg));
	} catch (err) {
		logger.error("Failed to relay CLI message to app", err);
		sendSessionErrorToHost(
			sender,
			`Failed to relay message to client ${clientId}`,
		);
	}
}
