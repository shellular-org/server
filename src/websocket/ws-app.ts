import { nanoid } from "nanoid";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { logger } from "@/logger";
import {
	type ClientToHostMsg,
	ClientToHostMsgSchema,
	MsgType,
	type PongMsg,
	parseBaseMessage,
	type SessionClientJoinedMsg,
	type SessionClientJoinMsg,
	type SessionClientLeftMsg,
	type SessionJoinedMsg,
} from "./protocol";
import {
	type ClientInfo,
	getSessionForSocket,
	removeSocket,
	type Session,
} from "./sessions";
import { sendSessionErrorToClient } from "./shared";

const CLIENT_APPROVAL_TIMEOUT_MS = 60_000;

type ApprovalDecision = {
	approved: boolean;
	reason: string;
};

type PreUpgradeApprovalEntry = {
	hostId: string;
	timer: ReturnType<typeof setTimeout>;
	resolve: (decision: ApprovalDecision) => void;
};

const preUpgradeApprovals = new Map<string, PreUpgradeApprovalEntry>();

/**
 * Returns true if the clientId is already connected or awaiting approval for
 * the given session.
 */
export function isClientOccupied(session: Session, clientId: string): boolean {
	const existingClient = session.clients.get(clientId);
	if (existingClient) {
		// User might be switching from one device to another, so we allow a new connection to take over an existing one.
		existingClient.ws.close();
		session.clients.delete(clientId);
	}
	return preUpgradeApprovals.has(clientId);
}

export function requestClientApprovalFromHost(
	session: Session,
	{
		clientId,
		appVersion,
		platform,
	}: { clientId: string; appVersion: string; platform: string },
): Promise<ApprovalDecision> {
	if (isClientOccupied(session, clientId)) {
		return Promise.resolve({
			approved: false,
			reason: "Client is already connected or pending approval",
		});
	}

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			const entry = preUpgradeApprovals.get(clientId);
			if (!entry) {
				return;
			}

			preUpgradeApprovals.delete(clientId);
			resolve({ approved: false, reason: "Connection request timed out" });
		}, CLIENT_APPROVAL_TIMEOUT_MS);

		preUpgradeApprovals.set(clientId, {
			hostId: session.hostId,
			timer,
			resolve,
		});

		try {
			notifyHostPendingClient(session.host, clientId, appVersion, platform);
		} catch {
			clearTimeout(timer);
			preUpgradeApprovals.delete(clientId);
			resolve({ approved: false, reason: "Failed to reach host" });
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
	const preUpgradeEntry = preUpgradeApprovals.get(clientId);
	if (!preUpgradeEntry) {
		return;
	}

	clearTimeout(preUpgradeEntry.timer);
	preUpgradeApprovals.delete(clientId);
	preUpgradeEntry.resolve(
		approved
			? { approved: true, reason: "" }
			: { approved: false, reason: "Connection rejected by host" },
	);
}

function notifyHostPendingClient(
	host: WebSocket,
	clientId: string,
	appVersion: string,
	platform: string,
): void {
	const joinMsg: SessionClientJoinMsg = {
		type: MsgType.SESSION_CLIENT_JOIN,
		data: { clientId, appVersion, platform },
	};
	host.send(JSON.stringify({ id: `server_${nanoid(8)}`, ...joinMsg }));
}

export function initAppWebSocket() {
	const wsServer = new WebSocketServer({ noServer: true });

	wsServer.on("connection", (ws) => {
		const entry = getSessionForSocket(ws);
		if (!entry || entry.role !== "client") {
			sendSessionErrorToClient(
				ws,
				"Something went wrong with this connection: role issue",
			);
			ws.close();
			return;
		}

		const { session, clientId } = entry;
		const clientInfo = session.clients.get(clientId);
		if (!clientInfo || clientInfo.ws !== ws) {
			sendSessionErrorToClient(
				ws,
				"Something went wrong with this connection: info issue",
			);
			ws.close();
			removeSocket(ws);
			return;
		}

		sendJoinedHandshake(ws, session);
		notifyHostClientJoined(session, clientInfo);

		ws.on("message", (raw) => {
			const rawStr = raw.toString();
			const parsedBaseMsg = parseBaseMessage(rawStr);
			if (!parsedBaseMsg) {
				sendSessionErrorToClient(ws, "Invalid message format");
				return;
			}

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

		ws.on("error", () => {
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
		data: {
			clientId: clientInfo.clientId,
			appVersion: clientInfo.appVersion,
			platform: clientInfo.platform,
		},
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
