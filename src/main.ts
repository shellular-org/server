import { createServer } from "node:http";

import express from "express";
import { z } from "zod";

import { initConfig } from "@/config";
import { registerHost } from "@/db/host";
import { env } from "@/env";
import { HttpError } from "@/error/http";
import { logger } from "@/logger";
import cors from "@/middleware/cors";
import { initWebSocketRelay } from "@/websocket/index";

process.on("uncaughtException", (err) => {
	logger.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	logger.error("Unhandled promise rejection:", reason);
});

initConfig();

const app = express();

app.use(cors);
app.use(express.json());

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

app.get("/health", (_req, res) => {
	res.json({ message: "OK" });
});

const HostRegisterReqSchema = z.object({
	machineId: z.string().min(1),
	platform: z.string().min(1),
});

app.post("/register", (req, res) => {
	const { machineId, platform } = HostRegisterReqSchema.parse(req.body);
	const hostId = registerHost(machineId, platform);
	res.json({
		success: true,
		data: { hostId },
	});
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
