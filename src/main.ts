import { createServer } from "node:http";

import express from "express";
import { z } from "zod";
import { initConfig } from "@/config";
import { env } from "@/env";
import { HttpError } from "@/error/http";
import { logger } from "@/logger";
import cors from "@/middleware/cors";
import { router as hostRouter } from "@/routes/host";
import { printRoutes } from "@/utils/express";
import { initWebSocketRelay } from "@/websocket/index";
import { getSessionStats } from "@/websocket/sessions";

process.on("uncaughtException", (err) => {
	logger.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	logger.error("Unhandled promise rejection:", reason);
});

initConfig();

const app = express();

app.set("trust proxy", 1); // trust first proxy (if behind a proxy like nginx or cloudflare)

app.use(cors);
app.use(express.json());

app.use(hostRouter);

app.use((req, res, next) => {
	const start = Date.now();

	res.on("finish", () => {
		const duration = Date.now() - start;

		const ip = req.ip;

		const logMsg = JSON.stringify({
			method: req.method,
			url: req.originalUrl,
			status: res.statusCode,
			duration,
			ip,
			userAgent: req.headers["user-agent"] || "-",
		});

		if (res.statusCode >= 400) {
			logger.error(logMsg);
		} else {
			logger.info(logMsg);
		}
	});

	next();
});

app.get("/health", (_req, res) => {
	res.json({ message: "OK" });
});

app.get("/stats", (_req, res) => {
	return res.json(getSessionStats());
});

app.use(
	(
		err: Error,
		_req: express.Request,
		res: express.Response,
		_next: express.NextFunction,
	) => {
		if (err instanceof z.ZodError) {
			res.status(400).json({
				success: false,
				error: err.message,
			});
			return;
		} else if (err instanceof HttpError && err.statusCode < 500) {
			res.status(err.statusCode).json({
				success: false,
				error: err.message,
			});
			return;
		}

		logger.error("Internal error:", err);
		res.status(500).json({ error: "Internal server error" });
	},
);

const server = createServer(app);
initWebSocketRelay(server);

server.listen(env.PORT, env.HOST, () => {
	logger.info(`Server is running on port ${env.PORT}`);
});

printRoutes(app);
