import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import { registerHost } from "@/db/host";
import { ForbiddenError, TooManyRequestsError } from "@/error/http";
import { logger } from "@/logger";
import { userAgentFilter } from "@/middleware/user-agent-filter";

export const router = Router();

const registerLimiter = rateLimit({
	windowMs: 24 * 60 * 60 * 1000, // 24 hours
	limit: 2, // max 2 requests per window per IP
	standardHeaders: false, // disable `RateLimit` header
	legacyHeaders: false, // disable `X-RateLimit-*`

	handler: (req, _res) => {
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

		throw new TooManyRequestsError(
			"Too many requests, please try again later.",
		);
	},
});

const HostRegisterReqSchema = z.object({
	machineId: z.string().min(16).max(128),
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
router.post(
	["/register", "/host/register"],
	userAgentFilter([/^shellular\/\d+\.\d+\.\d+$/]),
	registerLimiter,
	(req, res) => {
		const parseResult = HostRegisterReqSchema.safeParse(req.body);
		if (!parseResult.success) {
			// we won't send zod error for security reasons
			// altho our code is open source so it could still be fucked with
			// but at least it won't be as easy to figure out the exact validation rules
			// without looking at the source code
			throw new ForbiddenError("Invalid request");
		}

		const { machineId, platform } = parseResult.data;
		const hostId = registerHost(machineId, platform);
		res.json({
			success: true,
			data: { hostId },
		});
	},
);
