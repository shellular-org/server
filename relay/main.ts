import {
  createBaseApp,
  installProcessErrorHandlers,
} from "@shared/express-app";
import { logger } from "@shared/logger";
import { errorHandler, notFoundHandler } from "@shared/middleware/error";

import { relayEnv } from "./env";
import { shutdownPostHog, startHostHeartbeatForPosthog } from "./posthog";
import {
  endRelayPresenceToCentral,
  initRelayPresenceToCentral,
} from "./presence";
import { getActiveHostSessions } from "./sessions";
import { initRelayUpgrade } from "./websocket/upgrade";

installProcessErrorHandlers("relay");

// Same Express boilerplate as central (trust proxy for nginx, `/`, error handling).
// The relay has no route modules — its HTTP surface is just the shared `/` + its own
// simple `/health`; everything else is over the WebSocket upgrade path, which
// attaches to the same underlying http server below.
const { app, server } = createBaseApp();

// The relay's health is a simple liveness check. (Central's /health additionally
// reports the live relay fleet.)
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Error + 404 handlers must be registered last, after all routes.
app.use(errorHandler);
app.use(notFoundHandler);

initRelayUpgrade(server);

// Daily-active heartbeat for long-lived host connections. Each relay knows its own
// local host sessions, so the sweep runs here (per relay) rather than centrally —
// the work is naturally partitioned across the fleet.
startHostHeartbeatForPosthog(() =>
  getActiveHostSessions().map((session) => session.hostInfo),
);

// Open the persistent control channel to central. While it's open central treats
// this relay as live; closing it (below, or on crash) is how central learns we're
// gone. Presence (host/client connect/disconnect) flows over this socket.
initRelayPresenceToCentral();

server.listen(relayEnv.RELAY_PORT, relayEnv.RELAY_HOST, () => {
  logger.info(
    `[relay ${relayEnv.RELAY_PUBLIC_URL}] listening on ${relayEnv.RELAY_HOST}:${relayEnv.RELAY_PORT}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info(`[relay] received ${signal}, shutting down`);
    // Closing the control socket makes central drop us + our presence immediately.
    endRelayPresenceToCentral();
    shutdownPostHog().finally(() => {
      server.close(() => process.exit(0));
    });
  });
}
