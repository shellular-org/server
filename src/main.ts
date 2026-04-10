import { createServer } from "node:http";
import { resolve } from "node:path";

import express from "express";

import { initConfig } from "config";
import { env } from "env";
import cors from "middleware/cors";
import { initWebSocketRelay } from "websocket/index";
import { cleanupStaleBuffers } from "websocket/sessions";
import { logger } from "logger";

process.on("uncaughtException", (err) => {
	logger.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	logger.error("Unhandled promise rejection:", reason);
});

initConfig();

const app = express();

app.use(express.json());
app.use(cors);

app.use(
	express.static(resolve("public"), {
		setHeaders: (res, path) => {
			if (path.endsWith("scanner.html")) {
				res.setHeader("Cache-Control", "public, max-age=86400");
			}
		},
	}),
);

app.use((req, res, next) => {
	const start = Date.now();

	res.on("finish", () => {
		const duration = Date.now() - start;
		const ip = req.headers["cf-connecting-ip"] || req.ip;

		const logMsg = JSON.stringify({
			method: req.method,
			url: req.originalUrl,
			status: res.statusCode,
			duration,
			ip,
		});

		if (res.statusCode >= 400) {
			logger.error(logMsg);
		} else {
			logger.info(logMsg);
		}
	});

	next();
});

app.get("/", async (_req, res) => {
	res.sendFile("public/index.html");
});

app.get("/health", (_req, res) => {
	res.json({ message: "OK" });
});

app.use(
	(
		err: Error,
		_req: express.Request,
		res: express.Response,
		_next: express.NextFunction,
	) => {
		logger.error("Unhandled request error:", err);
		res.status(500).json({ error: "Internal server error" });
	},
);

// Stale terminal buffer cleanup — every hour
setInterval(
	() => {
		cleanupStaleBuffers();
	},
	60 * 60 * 1000,
);

const server = createServer(app);
initWebSocketRelay(server);

server.listen(env.PORT, env.HOST, () => {
	logger.info(`Server is running on port ${env.PORT}`);
});
