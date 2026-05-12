import {
	BaseMsgSchema,
	type ClientInfo,
	MsgType,
	type PongMsg,
	parseMessage,
	type SessionClientJoinedMsg,
	type SessionClientJoinMsg,
	type SessionClientLeftMsg,
	type SessionJoinedMsg,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { registerClient } from "@/db/client";
import { logger } from "@/logger";
import { type ClientToHostMsg, ClientToHostMsgSchema } from "./protocol";
import {
	getSessionForSocket,
	removeClient,
	removeSocket,
	type Session,
} from "./sessions";
import {
	CloseCodeAndReason,
	type CloseCodeAndReasonValue,
	closeWsWithError,
	sendSessionErrorToClient,
} from "./shared";

const CLIENT_APPROVAL_TIMEOUT_MS = 60_000;

type ApprovalDecision = {
	approved: boolean;
	reason: string;
};

type PendingApproval = {
	hostId: string;
	timer: ReturnType<typeof setTimeout>;
	resolve: (decision: ApprovalDecision) => void;
};

const pendingApprovals = new Map<string, PendingApproval>();

export function requestClientApprovalFromHost(
	session: Session,
	clientInfo: ClientInfo,
): Promise<CloseCodeAndReasonValue | undefined> {
	const { clientId } = clientInfo;
	const pendingApprovalEntry = pendingApprovals.get(clientId);
	if (pendingApprovalEntry) {
		logger.info(
			`Replacing pending app connection clientId=${clientId} & hostId=${session.hostId}: occupied or pending`,
		);
		clearTimeout(pendingApprovalEntry.timer);
		pendingApprovals.delete(clientId);
	}

	const existingClient = session.clients.get(clientId);
	if (existingClient && pendingApprovalEntry) {
		const { code, reason } = CloseCodeAndReason.CLIENT_REPLACED;
		logger.info(
			`Closing existing app connection for clientId=${clientId} & hostId=${session.hostId} with code=${code} reason=${reason} to allow new connection`,
		);
		closeWsWithError(existingClient.ws, code, reason);
		removeClient(session.id, clientId);
	} else if (existingClient && !pendingApprovalEntry) {
		logger.info(
			`Rejecting new app connection for clientId=${clientId} & hostId=${session.hostId} because an active connection already exists and no pending approval was found`,
		);

		return Promise.resolve(CloseCodeAndReason.SESSION_JOIN_FAILED);
	}

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			const entry = pendingApprovals.get(clientId);
			if (!entry) {
				return;
			}

			pendingApprovals.delete(clientId);
			logger.info(
				`App join approval timed out for hostId=${session.hostId} clientId=${clientId}`,
			);
			resolve(CloseCodeAndReason.SESSION_JOIN_FAILED);
		}, CLIENT_APPROVAL_TIMEOUT_MS);

		pendingApprovals.set(clientId, {
			hostId: session.hostId,
			timer,
			resolve: (approval) => {
				if (approval.approved) {
					resolve(undefined);
				} else {
					logger.info(
						`App join approval rejected by host for hostId=${session.hostId} clientId=${clientId} reason=${approval.reason}`,
					);
					resolve(CloseCodeAndReason.APPROVAL_DENIED);
				}
			},
		});

		try {
			logger.info(
				`Requesting app join approval for hostId=${session.hostId} clientId=${clientId}`,
			);
			notifyHostPendingClient(session.host, clientInfo);
		} catch {
			clearTimeout(timer);
			pendingApprovals.delete(clientId);
			logger.info(
				`Failed to notify host about app join for hostId=${session.hostId} clientId=${clientId}`,
			);
			resolve(CloseCodeAndReason.APPROVAL_DENIED);
		}
	});
}

/**
 * Called by ws-cli.ts when the CLI host approves or rejects a pending client.
 */
export function resolvePendingClient(
	clientId: string,
	approved: boolean,
): void {
	const preUpgradeEntry = pendingApprovals.get(clientId);
	if (!preUpgradeEntry) {
		return;
	}

	clearTimeout(preUpgradeEntry.timer);
	pendingApprovals.delete(clientId);
	logger.info(
		`Resolved app join approval for hostId=${preUpgradeEntry.hostId} clientId=${clientId} approved=${approved}`,
	);
	preUpgradeEntry.resolve(
		approved
			? { approved: true, reason: "" }
			: { approved: false, reason: "Connection rejected by host" },
	);
}

function notifyHostPendingClient(
	host: WebSocket,
	clientInfo: ClientInfo,
): void {
	const joinMsg: SessionClientJoinMsg = {
		type: MsgType.SESSION_CLIENT_JOIN,
		data: clientInfo,
	};
	host.send(JSON.stringify({ id: `server_${nanoid(8)}`, ...joinMsg }));
}

export function initAppWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });

	wsServer.on("connection", (ws) => {
		logger.info("App websocket connection established");
		const entry = getSessionForSocket(ws);
		if (!entry || entry.role !== "client") {
			logger.info("Closing app websocket: missing or invalid session role");
			sendSessionErrorToClient(
				ws,
				"Something went wrong with this connection: role issue",
			);
			ws.close();
			return;
		}

		const { session, clientId } = entry;
		const clientWithWs = session.clients.get(clientId);
		if (!clientWithWs || clientWithWs.ws !== ws) {
			logger.info(
				`Closing app websocket: session info mismatch for hostId=${session.hostId} clientId=${clientId}`,
			);
			sendSessionErrorToClient(
				ws,
				"Something went wrong with this connection: info issue",
			);
			ws.close();
			removeSocket(ws);
			return;
		}

		sendJoinedHandshake(ws, session);
		notifyHostClientJoined(session, clientWithWs.info);
		registerClient(clientWithWs.info);

		ws.on("message", (raw) => {
			const rawStr = raw.toString();
			const parsedBase = parseMessage(rawStr, BaseMsgSchema);
			if (!parsedBase.data) {
				sendSessionErrorToClient(ws, "Invalid message format");
				return;
			}

			const parsedBaseMsg = parsedBase.data;

			if (parsedBaseMsg.type === MsgType.PING) {
				const pongMsg: PongMsg = {
					type: MsgType.PONG,
					respTo: parsedBaseMsg.id,
				};
				ws.send(JSON.stringify({ id: `server_${nanoid(8)}`, ...pongMsg }));
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

		ws.on("close", (code, reason) => {
			logger.info(
				`App websocket closed code=${code} reason=${reason.toString() || "<empty>"}`,
			);
			const entry = getSessionForSocket(ws);
			if (entry && entry.role === "client" && entry.clientId) {
				pendingApprovals.delete(entry.clientId);
				// Notify CLI that client disconnected
				const { session, clientId } = entry;
				const activeClient = session.clients.get(clientId);
				if (session.host && activeClient?.ws === ws) {
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

		ws.on("error", (err) => {
			logger.error("App websocket error", err);
			const entry = getSessionForSocket(ws);
			if (entry?.role === "client" && entry.clientId) {
				pendingApprovals.delete(entry.clientId);
			}
			removeSocket(ws);
		});
	});

	return wsServer;
}

function sendJoinedHandshake(ws: WebSocket, session: Session): void {
	const joinedMsg: SessionJoinedMsg = {
		type: MsgType.SESSION_JOINED,
		data: { ...session.hostInfo, sessionId: session.id },
	};
	ws.send(JSON.stringify({ id: `server_${nanoid(8)}`, ...joinedMsg }));
}

function notifyHostClientJoined(
	session: Session,
	clientInfo: ClientInfo,
): void {
	const clientJoinedMsg: SessionClientJoinedMsg = {
		type: MsgType.SESSION_CLIENT_JOINED,
		data: clientInfo,
	};
	session.host.send(
		JSON.stringify({ id: `server_${nanoid(8)}`, ...clientJoinedMsg }),
	);
}

function relayToCli(clientWs: WebSocket, msg: ClientToHostMsg) {
	const entry = getSessionForSocket(clientWs);
	if (!entry) {
		sendSessionErrorToClient(
			clientWs,
			"Client is not attached to a session",
			msg.id,
		);
		return;
	}

	if (entry.role !== "client") {
		logger.error("Received app message from a non-client socket");
		sendSessionErrorToClient(
			clientWs,
			"Only clients can send messages to host",
			msg.id,
		);
		return;
	}

	const { session, clientId } = entry;
	if (!session.clients.has(clientId)) {
		sendSessionErrorToClient(
			clientWs,
			"Client is no longer authorized for this session",
			msg.id,
		);
		clientWs.close();
		return;
	}

	if (!session.host) {
		sendSessionErrorToClient(
			clientWs,
			"Host is not currently connected",
			msg.id,
		);
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
		sendSessionErrorToClient(
			clientWs,
			"Failed to relay message to host",
			msg.id,
		);
	}
}
