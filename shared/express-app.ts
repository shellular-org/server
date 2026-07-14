import { createServer, type Server } from "node:http";

import express from "express";
import { GIT_COMMIT } from "./current-commit";
import { logger } from "./logger";
import cors from "./middleware/cors";
import { printRoutes } from "./print-routes";
import type { RouteModule } from "./types";

/**
 * The "before routes" Express boilerplate shared by BOTH central and the relay:
 * trust-proxy (they sit behind nginx), JSON body parsing, CORS, request logging,
 * and `/` with the git commit. Each app then adds its own routes (`/health`,
 * central's `/stats`, …) and MUST finish by `app.use()`-ing `errorHandler` +
 * `notFoundHandler` from `shared/middleware/error` last. The WS-terminating relay
 * also grabs the returned `server` to attach its `upgrade` handler.
 */
export interface BaseAppOptions {
  /** Route modules (router + mount prefix) to mount. */
  routes?: readonly RouteModule[];
}

export interface BaseApp {
  app: express.Express;
  server: Server;
}

export function createBaseApp(options: BaseAppOptions = {}): BaseApp {
  const { routes = [] } = options;

  const app = express();

  // Behind nginx / a reverse proxy, so trust the first proxy for req.ip and
  // X-Forwarded-* headers.
  app.set("trust proxy", 1);

  app.use(cors);
  app.use(express.json());

  for (const { prefix, router } of routes) {
    if (prefix) {
      app.use(prefix, router);
    } else {
      app.use(router);
    }
  }

  // Request logging.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const logMsg = JSON.stringify({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration: Date.now() - start,
        ip: req.ip,
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

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      message:
        "Welcome to Shellular. Visit https://shellular.dev to download the app and get started.",
      git: {
        repo: "https://github.com/shellular-org/server",
        commit: GIT_COMMIT.sha,
        message: GIT_COMMIT.message,
      },
    });
  });

  return { app, server: createServer(app) };
}

/**
 * Install the process-wide `uncaughtException` / `unhandledRejection` guards both
 * apps want. `label` prefixes the logs so central vs relay is distinguishable.
 */
export function installProcessErrorHandlers(label: string): void {
  const prefix = `[${label}] `;
  process.on("uncaughtException", (err) => {
    logger.error(`${prefix}Uncaught exception:`, err);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`${prefix}Unhandled promise rejection:`, reason);
  });
}

export { printRoutes };
