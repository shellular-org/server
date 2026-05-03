import { MsgType, type SessionErrorMsg } from "@shellular/protocol";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";

import { env } from "@/env";
import { logger } from "@/logger";

function sendSessionErrorMsg(
	ws: WebSocket,
	error: string,
	clientId?: string,
	debugInfo?: Record<string, unknown>,
) {
	const errorId = `server_${nanoid(8)}`;
	const respMsg: SessionErrorMsg = {
		type: MsgType.SESSION_ERROR,
		respTo: clientId,
		error,
	};
	ws.send(JSON.stringify({ id: errorId, ...respMsg }));

	if (env.NODE_ENV === "dev" && debugInfo) {
		logger.error(JSON.stringify(debugInfo, null, 2));
	}
}

/**
 * Sends a session:error message to host (CLI).
 *
 *
 * @param ws The host WebSocket to which the error message should be sent.
 * @param error The error message to be sent.
 * @param debugInfo Optional additional debug information to be logged in development mode. This can include details about the error context, such as the raw message that caused the error or any relevant state information. This debug info will not be sent to the host but will be logged on the server for troubleshooting purposes.
 */
export function sendSessionErrorToHost(
	ws: WebSocket,
	error: string,
	debugInfo?: Record<string, unknown>,
) {
	sendSessionErrorMsg(ws, error, undefined, debugInfo);
}

/**
 * Sends a session:error message to client (app).
 *
 * @param ws The client WebSocket to which the error message should be sent.
 * @param error The error message to be sent.
 * @param respTo? The ID of msg to which we're responding. This is optional because in some cases (like when host disconnects) there might not be a specific msg that caused the error, but we still want to notify the client about the error.
 * @param debugInfo Optional additional debug information to be logged in development mode. This can include details about the error context, such as the raw message that caused the error or any relevant state information. This debug info will not be sent to the client but will be logged on the server for troubleshooting purposes.
 */
export function sendSessionErrorToClient(
	ws: WebSocket,
	error: string,
	respTo?: string,
	debugInfo?: Record<string, unknown>,
) {
	sendSessionErrorMsg(ws, error, respTo, debugInfo);
}

export const CloseCodeAndReason = {
	HOST_UNAVAILABLE: { code: 4001, reason: "host_unavailable" },
	INVALID_QUERY: { code: 4002, reason: "invalid_query" },
	APPROVAL_DENIED: { code: 4003, reason: "approval_denied" },
	SESSION_JOIN_FAILED: { code: 4004, reason: "session_join_failed" },
	HOST_DISCONNECTED: { code: 4005, reason: "host_disconnected" },
	CLIENT_REPLACED: { code: 4006, reason: "client_replaced" },
	HOST_AUTH_FAILED: { code: 4007, reason: "host_auth_failed" },
} as const;

export function closeWsWithError(ws: WebSocket, code: number, reason: string) {
	// reason should stay short (<123 bytes)
	logger.info(`Closing websocket with code=${code} reason=${reason}`);
	ws.close(code, reason.slice(0, 123));
}
