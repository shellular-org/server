import type http from "node:http";

import type { WebSocket, WebSocketServer } from "ws";

import { initCliWebSocket } from "./ws-cli";
import { initAppWebSocket } from "./ws-app";
import { logger } from "logger";

const PING_INTERVAL_MS = 30_000;

export function initWebSocketRelay(server: http.Server) {
	const cliWsServer = initCliWebSocket();
	const appWsServer = initAppWebSocket();

	server.on("upgrade", (request, socket, head) => {
		logger.info(`WebSocket upgrade request received: ${request.url}`);

		if (request.url === "/cli") {
			cliWsServer.handleUpgrade(request, socket, head, (ws) => {
				cliWsServer.emit("connection", ws, request);
			});
		} else if (request.url === "/app") {
			appWsServer.handleUpgrade(request, socket, head, (ws) => {
				appWsServer.emit("connection", ws, request);
			});
		} else {
			socket.destroy(); // Reject connection for unknown paths
		}
	});

	setupKeepAlive(cliWsServer);
	setupKeepAlive(appWsServer);

	return { cliWsServer, appWsServer };
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
				ws.terminate();
				continue;
			}

			aliveSet.delete(ws);
			ws.ping();
		}
	}, PING_INTERVAL_MS);
}
