import {
	BaseMsgSchema,
	MsgType,
	type PongMsg,
	parseMessage,
	SessionClientJoinResultMsgSchema,
	type SessionHostedMsg,
	type SessionHostMsg,
	SessionHostMsgSchema,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { getHost, verifyHost } from "@/db/host";
import { logger } from "@/logger";
import { type HostToClientMsg, HostToClientMsgSchema } from "./protocol";
import {
	createSession,
	getActiveSessionForHost,
	getSessionForSocket,
	removeSocket,
	type Session,
} from "./sessions";
import {
	CloseCodeAndReason,
	closeWsWithError,
	sendSessionErrorToClient,
	sendSessionErrorToHost,
	setupKeepAlive,
} from "./shared";
import { resolvePendingClient } from "./ws-app";

const PROXY_BINARY_MAGIC = Buffer.from("SHPB");
const PROXY_BINARY_HEADER_BYTES = 4 + 1 + 1 + 1 + 24;

export function initCliWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });
	setupKeepAlive(wsServer, "host");

	wsServer.on("connection", (ws) => {
		/**
		 * Session associated with this WebSocket connection.
		 * Only set after successful authentication. If null, the connection is not authenticated yet.
		 */
		let session: Session | null = null;

		ws.on("message", (raw, isBinary) => {
			if (isBinary) {
				if (!session) {
					sendSessionErrorToHost(
						ws,
						"Received binary proxy frame before authentication",
					);
					return;
				}

				relayBinaryToApp(ws, rawToBuffer(raw));
				return;
			}

			const rawStr = raw.toString();

			const parsedBase = parseMessage(rawStr, BaseMsgSchema);
			if (!parsedBase.data) {
				sendSessionErrorToClient(ws, "Invalid message format");
				return;
			}

			const parsedBaseMsg = parsedBase.data;

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
					logger.error("Host authentication failed", err);
					const { code, reason } = CloseCodeAndReason.HOST_AUTH_FAILED;
					closeWsWithError(ws, code, reason);
					return;
				}

				return;
			}

			// Handle client approval result sent by the CLI host
			if (parsedBaseMsg.type === MsgType.SESSION_CLIENT_JOIN_RESULT) {
				const parsed =
					SessionClientJoinResultMsgSchema.safeParse(parsedBaseMsg);

				if (!parsed.success) {
					sendSessionErrorToHost(ws, "Invalid client approval message", {
						rawStr,
						zodError: z.treeifyError(parsed.error),
					});
				} else {
					resolvePendingClient(
						session.hostId,
						parsed.data.data.clientId,
						parsed.data.data.approved,
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
			removeSocket(ws);
		});

		ws.on("error", () => removeSocket(ws));
	});

	return wsServer;
}

function rawToBuffer(raw: RawData): Buffer {
	if (Buffer.isBuffer(raw)) {
		return raw;
	}

	if (Array.isArray(raw)) {
		return Buffer.concat(raw);
	}

	return Buffer.from(raw);
}

function handleAuth(ws: WebSocket, msg: SessionHostMsg): Session {
	const { id: hostId, machineId, platform } = msg.data;

	if (!hostId || !machineId || !platform) {
		throw new Error("Missing hostId, machineId, or platform");
	}

	const host = getHost(hostId);
	if (!host) {
		throw new Error("Unknown host");
	}

	const verified = verifyHost(host, {
		id: hostId,
		machineId,
		platform,
	});
	if (!verified) {
		throw new Error(
			"Suspicious host: Machine ID is different from the registered one",
		);
	}

	const existing = getActiveSessionForHost(hostId);
	if (existing) {
		throw new Error(
			`Host already has an active connection (hostId: ${hostId})`,
		);
	}

	const session = createSession(hostId, ws, msg.data);

	// complete handshake with the host (CLI)
	const hostedId = `server_${nanoid(8)}`;
	const respMsg: SessionHostedMsg = {
		type: MsgType.SESSION_HOSTED,
		data: { sessionId: session.id },
	};
	ws.send(JSON.stringify({ id: hostedId, ...respMsg }));

	return session;
}

function relayToApp(hostWs: WebSocket, msg: HostToClientMsg) {
	const entry = getSessionForSocket(hostWs);
	if (!entry) {
		sendSessionErrorToHost(hostWs, "Host is not attached to a session");
		return;
	}

	const { session } = entry;
	const clientId = msg.clientId;

	const clientInfo = session.clients.get(clientId);
	if (!clientInfo) {
		sendSessionErrorToHost(hostWs, `Client ${clientId} is not connected`);
		return;
	}

	try {
		clientInfo.ws.send(JSON.stringify(msg));
	} catch (err) {
		logger.error("Failed to relay CLI message to app", err);
		sendSessionErrorToHost(
			hostWs,
			`Failed to relay message to client ${clientId}`,
		);
	}
}

function getProxyBinaryClientId(frame: Buffer): string | null {
	if (frame.length < PROXY_BINARY_HEADER_BYTES) {
		return null;
	}

	if (!frame.subarray(0, 4).equals(PROXY_BINARY_MAGIC)) {
		return null;
	}

	const clientIdLength = frame.readUInt8(6);
	const clientIdStart = PROXY_BINARY_HEADER_BYTES;
	const clientIdEnd = clientIdStart + clientIdLength;
	if (clientIdLength === 0 || frame.length <= clientIdEnd) {
		return null;
	}

	return frame.toString("utf8", clientIdStart, clientIdEnd);
}

function relayBinaryToApp(hostWs: WebSocket, frame: Buffer) {
	const entry = getSessionForSocket(hostWs);
	if (!entry) {
		sendSessionErrorToHost(hostWs, "Host is not attached to a session");
		return;
	}

	const clientId = getProxyBinaryClientId(frame);
	if (!clientId) {
		sendSessionErrorToHost(hostWs, "Invalid binary proxy frame");
		return;
	}

	const clientInfo = entry.session.clients.get(clientId);
	if (!clientInfo) {
		sendSessionErrorToHost(hostWs, `Client ${clientId} is not connected`);
		return;
	}

	try {
		clientInfo.ws.send(frame, { binary: true });
	} catch (err) {
		logger.error("Failed to relay binary CLI frame to app", err);
		sendSessionErrorToHost(
			hostWs,
			`Failed to relay binary frame to client ${clientId}`,
		);
	}
}
