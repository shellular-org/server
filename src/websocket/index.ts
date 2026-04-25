import type http from "node:http";
import type { Duplex } from "node:stream";
import { ClientInfoSchema } from "@shellular/protocol";
import type { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { getHost } from "@/db";
import { logger } from "@/logger";
import { getActiveSessionForHost, joinSession } from "./sessions";
import { CloseCodeAndReason } from "./shared";
import { initAppWebSocket, requestClientApprovalFromHost } from "./ws-app";
import { initCliWebSocket } from "./ws-cli";

const PING_INTERVAL_MS = 30_000;

const HostQuerySchema = z.object({
	hostId: z.string(),
});

const cliWsServer = initCliWebSocket();
const appWsServer = initAppWebSocket();

export function initWebSocketRelay(server: http.Server) {
	server.on("upgrade", (request, socket, head) => {
		handleUpgradeRequest(request, socket, head);
	});

	setupKeepAlive(cliWsServer);
	setupKeepAlive(appWsServer);

	return { cliWsServer, appWsServer };
}

function closeWithError(ws: WebSocket, code: number, reason: string) {
	// reason should stay short (<123 bytes)
	ws.close(code, reason.slice(0, 123));
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
				closeWithError(ws, code, reason);
				return;
			}

			const { hostId } = parsed.data;
			if (!getHost(hostId)) {
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				closeWithError(ws, code, reason);
				return;
			}

			cliWsServer.emit("connection", ws, request);
		});

		return;
	}

	if (pathname === "/app") {
		// async approval before upgrade is fine
		const parsed = ClientInfoSchema.safeParse(query);

		appWsServer.handleUpgrade(request, socket, head, async (ws) => {
			if (!parsed.success) {
				const { code, reason } = CloseCodeAndReason.INVALID_QUERY;
				closeWithError(ws, code, reason);
				return;
			}

			const { hostId } = parsed.data;
			const host = getHost(hostId);
			if (!host) {
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				closeWithError(ws, code, reason);
				return;
			}

			const session = getActiveSessionForHost(hostId);
			if (!session) {
				const { code, reason } = CloseCodeAndReason.HOST_UNAVAILABLE;
				closeWithError(ws, code, reason);
				return;
			}

			const approval = await requestClientApprovalFromHost(
				session,
				parsed.data,
			);
			if (!approval.approved) {
				const { code, reason } = CloseCodeAndReason.APPROVAL_DENIED;
				closeWithError(ws, code, reason);
				return;
			}

			const joined = joinSession(session.id, ws, parsed.data);
			if (!joined) {
				const { code, reason } = CloseCodeAndReason.SESSION_JOIN_FAILED;
				closeWithError(ws, code, reason);
				return;
			}

			appWsServer.emit("connection", ws, request);
		});

		return;
	}

	// only unknown route gets hard rejected
	socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
	socket.destroy();
}

function setupKeepAlive(wsServer: WebSocketServer) {
	const aliveSet = new WeakSet<WebSocket>();

	wsServer.on("connection", (ws) => {
		aliveSet.add(ws);

		ws.on("pong", () => {
			aliveSet.add(ws);
		});

		ws.on("close", () => {
			aliveSet.delete(ws);
		});
	});

	// Periodic ping to detect dead connections and keep connections alive
	// through reverse proxies and load balancers
	setInterval(() => {
		for (const ws of wsServer.clients) {
			if (!aliveSet.has(ws)) {
				continue;
			}

			aliveSet.delete(ws);
			ws.ping();
		}
	}, PING_INTERVAL_MS);
}
