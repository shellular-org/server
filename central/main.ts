import { env } from "@central/env";
import { initNotices } from "@central/notices";
import { initRelayPresenceWs } from "@central/relays/presence-ws";
import { getPresenceStats } from "@central/relays/registry";
import authRoutes from "@central/routes/auth";
import hostRoutes from "@central/routes/host";
import noticesRoutes from "@central/routes/notices";
import utilsRoutes from "@central/routes/utils";
import {
  createBaseApp,
  installProcessErrorHandlers,
  printRoutes,
} from "@shared/express-app";
import { logger } from "@shared/logger";
import { errorHandler, notFoundHandler } from "@shared/middleware/error";
import type { RouteModule } from "@shared/types";

installProcessErrorHandlers("central");

const routes: RouteModule[] = [
  authRoutes,
  hostRoutes,
  utilsRoutes,
  noticesRoutes,
];

const { app, server } = createBaseApp({ routes });

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/stats", (_req, res) => {
  // Central no longer holds live WebSocket sessions (relays do). It reports the
  // host presence it knows from relay `host-online`/`host-offline` reports.
  res.json(getPresenceStats());
});

// Error + 404 handlers must be registered last, after all routes.
app.use(errorHandler);
app.use(notFoundHandler);

// Central terminates only ONE kind of WebSocket: the relay control channel
// (`/relay`), which carries relay liveness + presence. App/CLI traffic is relayed
// by the regional relays, not here.
initRelayPresenceWs(server);

initNotices();

server.listen(env.CENTRAL_PORT, env.CENTRAL_HOST, () => {
  logger.info(`Server is running on port ${env.CENTRAL_PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}

printRoutes(app, routes);
