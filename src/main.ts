import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import express from "express";

import { initConfig } from "config";
import { env } from "env";
import cors from "middleware/cors";
import { initWebSocket } from "websocket/index";
import { cleanupStaleBuffers } from "websocket/sessions";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

initConfig();

const app = express();

app.use(
  express.static(resolve("public"), {
    setHeaders: (res, path) => {
      if (path.endsWith("scanner.html")) {
        // always revalidate
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  }),
);

app.use(express.json());
app.use(cors);

app.get("/", async (_req, res) => {
  res.sendFile("public/index.html");
});

app.get("/health", (_req, res) => {
  res.json({ message: "OK" });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Stale terminal buffer cleanup — every hour
setInterval(
  () => {
    cleanupStaleBuffers();
  },
  60 * 60 * 1000,
);

const server = createServer(app);
initWebSocket(server);

server.listen(env.PORT, env.HOST, () => {
  console.info(`Server is running on port ${env.PORT}`);
});
