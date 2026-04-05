import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { initConfig } from "config";
import dotenv from "dotenv";
import Express from "express";
import cors from "middleware/cors";
import { init } from "utils/db";
import { initWebSocket } from "websocket/index";
import {
	cleanupStaleBuffers,
	getAndClearTerminalBuffer,
	getHttpClient,
	getSession,
	joinSessionHttp,
} from "websocket/sessions";

dotenv.config();

process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	console.error("Unhandled promise rejection:", reason);
});

const app = Express();
const PORT = process.env.PORT || 3000;
const indexHtml = readFileSync(resolve("public/index.html"), "utf-8");

(async function main() {
	await init();
	initConfig();

	app.get("/", async (_req, res) => {
		res.send(indexHtml);
	});

	app.use(Express.static(resolve("public")));
	app.use(Express.json());
	app.use(cors);

	app.get("/health", (_req, res) => {
		res.status(200).send("OK");
	});

	// ─── HTTP Polling Endpoints ──────────────────────────────────────────

	app.post("/api/session/join", (req, res) => {
		const { token } = req.body ?? {};
		if (!token || typeof token !== "string") {
			res.status(400).json({ error: "Missing token" });
			return;
		}
		const session = getSession(token);
		if (!session) {
			res.status(404).json({ error: "Invalid session token" });
			return;
		}
		const clientId = randomUUID().slice(0, 8);
		joinSessionHttp(token, clientId);
		// Notify the host that a client joined
		try {
			session.host.send(
				JSON.stringify({ type: "session:client-joined", id: "0", data: {} }),
			);
		} catch {}
		res.json({ clientId, hostInfo: session.hostInfo });
	});

	app.post("/api/exchange", (req, res) => {
		const { clientId, outgoing } = req.body ?? {};
		if (!clientId || typeof clientId !== "string") {
			res.status(400).json({ error: "Missing clientId" });
			return;
		}
		const entry = getHttpClient(clientId);
		if (!entry) {
			res.status(404).json({ error: "Unknown clientId" });
			return;
		}
		// Forward outgoing messages to host
		if (Array.isArray(outgoing)) {
			for (const msg of outgoing) {
				if (msg && typeof msg === "object" && msg.type) {
					try {
						entry.session.host.send(JSON.stringify(msg));
					} catch {}
				}
			}
		}
		// Return buffered incoming messages
		const messages = entry.httpClient.queue.splice(0);
		res.json({ messages });
	});

	app.post("/api/terminal/buffer", (req, res) => {
		const { clientId, terminalId } = req.body ?? {};
		if (!clientId || typeof clientId !== "string") {
			res.status(400).json({ error: "Missing clientId" });
			return;
		}
		if (!terminalId || typeof terminalId !== "string") {
			res.status(400).json({ error: "Missing terminalId" });
			return;
		}
		const entry = getHttpClient(clientId);
		if (!entry) {
			res.status(404).json({ error: "Unknown clientId" });
			return;
		}
		const buffer = getAndClearTerminalBuffer(entry.session, terminalId);
		res.json({ buffer });
	});

	// Stale terminal buffer cleanup — every hour
	setInterval(
		() => {
			cleanupStaleBuffers();
		},
		60 * 60 * 1000,
	);

	app.use(
		(
			err: Error,
			_req: Express.Request,
			res: Express.Response,
			_next: Express.NextFunction,
		) => {
			console.error("Unhandled request error:", err);
			res.status(500).json({ error: "Internal server error" });
		},
	);

	const server = createServer(app);
	initWebSocket(server);

	server.listen(Number(PORT), "0.0.0.0", 0, () => {
		console.info(`Server is running on port ${PORT}`);
	});
})();
