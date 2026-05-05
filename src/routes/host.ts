import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import { registerHost } from "@/db/host";
import { logger } from "@/logger";

export const router = Router();

const registerLimiter = rateLimit({
	windowMs: 24 * 60 * 60 * 1000, // 24 hours
	limit: 2, // max 2 requests per window per IP
	standardHeaders: false, // disable `RateLimit` header
	legacyHeaders: false, // disable `X-RateLimit-*`

	handler: (req, res) => {
		logger.error(
			JSON.stringify({
				event: "RATE_LIMIT_EXCEEDED",
				ip: req.ip,
				method: req.method,
				url: req.originalUrl,
				userAgent: req.headers["user-agent"],
				timestamp: new Date().toISOString(),
			}),
		);

		res.status(429).json({
			error: "Too many requests, please try again later.",
		});
	},
});

const HostRegisterReqSchema = z.object({
	machineId: z.string().min(1),
	platform: z.enum([
		"aix",
		"android",
		"darwin",
		"freebsd",
		"linux",
		"openbsd",
		"sunos",
		"win32",
	]),
});

// keeping /register for backwards compatibility. will remove it in a week.
router.post(["/register", "/host/register"], registerLimiter, (req, res) => {
	const { machineId, platform } = HostRegisterReqSchema.parse(req.body);
	const hostId = registerHost(machineId, platform);
	res.json({
		success: true,
		data: { hostId },
	});
});
