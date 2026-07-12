import type http from "node:http";
import type { Duplex } from "node:stream";

import {
	type ClientInfoRequest,
	ClientInfoRequestSchema,
} from "@shellular/protocol";
import { z } from "zod";

import {
	type AppWebSocketTokenPayload,
	verifyAppWebSocketToken,
} from "@/auth/ws-app-ticket";
import { getClient, verifyClient } from "@/db/client";
import { getHost } from "@/db/host";
import { env } from "@/env";
import { logger } from "@/logger";
import { captureAppConnection, captureLegacyAppConnection } from "@/posthog";
import { getActiveSessionForHost, joinSession } from "./sessions";
import { CloseCodeAndReason, closeWsWithError } from "./shared";
import { initAppWebSocket, requestClientApprovalFromHost } from "./ws-app";
import { initCliWebSocket } from "./ws-cli";

const HostQuerySchema = z.object({
	hostId: z.string(),
});

const AppAuthQuerySchema = z
	.object({
		wsToken: z.string().min(1),
	})
	.strict();

type AppConnectionAuth =
	| { clientInfo: AppWebSocketTokenPayload; userId: string; legacy: false }
	// Legacy clients predate the wsToken handshake, so no identity was ever
	// proven for them
	| { clientInfo: ClientInfoRequest; userId: null; legacy: true };

const cliWsServer = initCliWebSocket();
const appWsServer = initAppWebSocket();

export function initWebSocketRelay(server: http.Server) {
	server.on("upgrade", (request, socket, head) => {
		handleUpgradeRequest(request, socket, head);
	});

	return { cliWsServer, appWsServer };
}

async function handleUpgradeRequest(
	request: http.IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<void> {
	const { pathname, searchParams } = new URL(
		request.url || "/",
		"http://localhost",
	);

	logger.info(`WebSocket upgrade request received: ${pathname}`);

	const query = Object.fromEntries(searchParams.entries());

	if (pathname === "/cli") {
		cliWsServer.handleUpgrade(request, socket, head, (ws) => {
			const parsed = HostQuerySchema.safeParse(query);
			if (!parsed.success) {
				const { code, reason } = CloseCodeAndReason.INVALID_QUERY;
				closeWsWithError(ws, code, reason);
				return;
			}

			const { hostId } = parsed.data;
			if (!getHost(hostId)) {
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				closeWsWithError(ws, code, reason);
				return;
			}

			cliWsServer.emit("connection", ws, request);
		});

		return;
	}

	if (pathname === "/app") {
		const origin = request.headers.origin ?? "";
		if (env.NODE_ENV !== "dev" && !isAppOriginAllowed(origin)) {
			logger.warn(`Rejecting app websocket: disallowed origin: '${origin}'`);
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}

		const auth = parseAppConnectionAuth(query);
		if (!auth) {
			logger.warn("Rejecting app websocket: missing or invalid app auth query");
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}

		const { clientInfo } = auth;

		// async approval before upgrade is fine
		appWsServer.handleUpgrade(request, socket, head, async (ws) => {
			const { hostId } = clientInfo;
			const host = getHost(hostId);
			if (!host) {
				logger.info(`Rejecting app websocket: host ${hostId} doesn't exist`);
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				closeWsWithError(ws, code, reason);
				return;
			}

			const existingClient = getClient(clientInfo.clientId);
			if (
				existingClient &&
				clientInfo.platform !== "browser" &&
				!verifyClient(clientInfo)
			) {
				logger.info(
					`Rejecting app websocket: client verification failed for clientId=${clientInfo.clientId}`,
				);
				const { code, reason } = CloseCodeAndReason.INVALID_QUERY;
				closeWsWithError(ws, code, reason);
				return;
			}

			const session = getActiveSessionForHost(hostId);
			if (!session) {
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				logger.info(
					`Rejecting app websocket: no active session for hostId=${hostId}`,
				);
				closeWsWithError(ws, code, reason);
				return;
			}

			const failure = await requestClientApprovalFromHost(session, clientInfo);
			if (failure) {
				logger.info(
					`Rejecting app websocket: approval denied for hostId=${hostId} clientId=${clientInfo.clientId} reason=${failure.reason}`,
				);
				closeWsWithError(ws, failure.code, failure.reason);
				return;
			}

			const joined = joinSession(session.id, ws, clientInfo);
			if (!joined) {
				const { code, reason } = CloseCodeAndReason.SESSION_JOIN_FAILED;
				logger.info(
					`Rejecting app websocket: join failed for hostId=${hostId} clientId=${clientInfo.clientId}`,
				);
				closeWsWithError(ws, code, reason);
				return;
			}

			if (auth.userId) {
				captureAppConnection(auth.userId, clientInfo, host.platform);
			} else {
				captureLegacyAppConnection(clientInfo, host.platform);
			}
			appWsServer.emit("connection", ws, request);
		});

		return;
	}

	// only unknown route gets hard rejected
	socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
	socket.destroy();
}

function parseAppConnectionAuth(
	query: Record<string, string>,
): AppConnectionAuth | null {
	if ("wsToken" in query) {
		const authParsed = AppAuthQuerySchema.safeParse(query);
		if (!authParsed.success) return null;

		const clientInfo = verifyAppWebSocketToken(authParsed.data.wsToken);
		if (!clientInfo) {
			logger.warn("Rejecting app websocket: invalid or expired wsToken");
			return null;
		}

		return { clientInfo, userId: clientInfo.user.id, legacy: false };
	}

	// Legacy path: identity is unproven, so strip any `user` a caller tried to
	// smuggle in through the query string rather than forwarding it to the CLI.
	const legacyParsed = ClientInfoRequestSchema.safeParse(query);
	if (!legacyParsed.success) return null;
	if (legacyParsed.data.platform === "browser") {
		logger.warn("Rejecting legacy browser websocket without wsToken");
		return null;
	}

	logger.warn(
		`Accepting legacy unauthenticated app websocket for clientId=${legacyParsed.data.clientId} hostId=${legacyParsed.data.hostId}`,
	);
	return { clientInfo: legacyParsed.data, userId: null, legacy: true };
}

const APP_PROTOCOL = "shellular:";
const WEB_PROTOCOLS = new Set(["https:", "wss:"]);

function isAppOriginAllowed(origin: string): boolean {
	try {
		const url = new URL(origin);

		if (url.protocol === APP_PROTOCOL) {
			return true;
		}

		if (!WEB_PROTOCOLS.has(url.protocol)) {
			return false;
		}

		if (
			url.hostname === "shellular.dev" ||
			url.hostname.endsWith(".shellular.dev")
		) {
			return true;
		}

		return false;
	} catch {
		return false;
	}
}
