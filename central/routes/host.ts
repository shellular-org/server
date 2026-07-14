import { getHost, registerHost, verifyHost } from "@central/db/host";
import { env } from "@central/env";
import { getLiveRelayUrls } from "@central/relays/registry";
import {
  BadRequestError,
  ForbiddenError,
  TooManyRequestsError,
} from "@shared/http-error";
import { logger } from "@shared/logger";
import {
  HOST_USER_AGENT_REGEX,
  userAgentFilter,
} from "@shared/middleware/user-agent-filter";
import { createCliWebSocketToken } from "@shared/ws-cli-ticket";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

const router = Router();
const ROUTE_PREFIX = "/host";

export default {
  router,
  prefix: ROUTE_PREFIX,
};

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
      `Too many requests, please try again later. If you think this is a mistake, please contact support at ${env.CONTACT_EMAIL}`,
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

const userAgentMiddleware = userAgentFilter([HOST_USER_AGENT_REGEX]);

router.post("/register", userAgentMiddleware, registerLimiter, (req, res) => {
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
});

const HostTokenRequestSchema = z.object({
  hostId: z.string().min(1),
  machineId: z.string().min(1),
  platform: z.string().min(1),
});

router.post("/token", userAgentMiddleware, async (req, res) => {
  const parsed = HostTokenRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid request");
  }

  const { hostId, machineId, platform } = parsed.data;

  const host = getHost(hostId);
  if (!host) {
    throw new BadRequestError("Host is not available");
  }

  if (!verifyHost(host, { id: hostId, machineId, platform })) {
    throw new ForbiddenError(
      "Host verification failed: machine identity does not match",
    );
  }

  const { token, ttlSeconds } = await createCliWebSocketToken({
    hostId,
    machineId,
    platform,
  });

  res.json({
    success: true,
    data: {
      token,
      ttlSeconds,
      relays: getLiveRelayUrls(),
    },
  });
});
