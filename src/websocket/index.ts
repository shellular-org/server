import type http from "node:http";

import type { WebSocket } from "ws";
import { Server } from "ws";

import {
  appendTerminalBuffer,
  createSession,
  getSession,
  getSessionForSocket,
  joinSession,
  pushToHttpClients,
  rehostSession,
  removeSocket,
  removeTerminalBuffer,
} from "./sessions";

const PING_INTERVAL_MS = 30_000;

export function initWebSocket(server: http.Server) {
  const wsServer = new Server({ server });

  // Ping all connected sockets periodically to keep connections alive
  // through reverse proxies and load balancers
  const aliveSet = new WeakSet<WebSocket>();

  wsServer.on("connection", (ws: WebSocket) => {
    aliveSet.add(ws);

    ws.on("pong", () => {
      aliveSet.add(ws);
    });

    // First message must be session:host or session:join
    let authenticated = false;

    ws.on("message", (raw) => {
      let msg: { type: string; id: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", id: "0", error: "Invalid JSON" }));
        return;
      }

      // Application-level ping — respond with pong
      if (msg.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong", id: msg.id }));
        } catch {}
        return;
      }

      if (!authenticated) {
        handleAuth(ws, msg);
        if (getSessionForSocket(ws)) {
          authenticated = true;
        }
        return;
      }

      // Relay message to the other side
      relay(ws, raw.toString());
    });

    ws.on("close", () => removeSocket(ws));
    ws.on("error", () => removeSocket(ws));
  });

  // Periodic ping to detect dead connections and keep proxies happy
  setInterval(() => {
    for (const ws of wsServer.clients) {
      if (!aliveSet.has(ws)) {
        ws.terminate();
        continue;
      }
      aliveSet.delete(ws);
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);

  console.info("WebSocket server initialized");
  return wsServer;
}

function handleAuth(ws: WebSocket, msg: { type: string; id: string; data?: Record<string, unknown> }) {
  if (msg.type === "session:host") {
    const data = msg.data ?? {};
    const machineId = String(data.machineId ?? data.token ?? "").trim();
    if (!machineId) {
      ws.send(
        JSON.stringify({
          type: "session:error",
          id: msg.id,
          error: "Missing machineId",
        }),
      );
      return;
    }
    const hostInfo = {
      hostname: String(data.hostname ?? "unknown"),
      platform: String(data.platform ?? "unknown"),
      dir: String(data.dir ?? "."),
      machineId,
    };

    if (getSession(machineId)) {
      rehostSession(machineId, ws, hostInfo);
    } else {
      createSession(machineId, ws, hostInfo);
    }

    ws.send(JSON.stringify({ type: "session:hosted", id: msg.id, data: { token: machineId } }));
  } else if (msg.type === "session:join") {
    const token = String(msg.data?.token ?? "");
    const session = joinSession(token, ws);

    if (!session) {
      ws.send(
        JSON.stringify({
          type: "session:error",
          id: msg.id,
          error: "Invalid session token",
        }),
      );
      return;
    }
    // Notify client of host info
    ws.send(
      JSON.stringify({
        type: "session:joined",
        id: msg.id,
        data: session.hostInfo,
      }),
    );
    // Notify host that a client joined
    try {
      session.host.send(JSON.stringify({ type: "session:client-joined", id: msg.id, data: {} }));
    } catch {}
  } else {
    ws.send(
      JSON.stringify({
        type: "error",
        id: msg.id ?? "0",
        error: "Must send session:host or session:join first",
      }),
    );
  }
}

function relay(sender: WebSocket, rawMessage: string) {
  const entry = getSessionForSocket(sender);
  if (!entry) return;

  const { session, role } = entry;
  if (role === "host") {
    // Intercept terminal:data to accumulate server-side buffer
    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed.type === "terminal:data" && parsed.data?.terminalId) {
        appendTerminalBuffer(session, parsed.data.terminalId, parsed.data.data ?? "");
      } else if (parsed.type === "terminal:closed" && parsed.data?.terminalId) {
        removeTerminalBuffer(session, parsed.data.terminalId);
      }
    } catch {}

    // Host → all WS clients
    for (const client of session.clients) {
      try {
        client.send(rawMessage);
      } catch {}
    }
    // Host → all HTTP polling clients
    pushToHttpClients(session, rawMessage);
  } else {
    // Client → host
    try {
      session.host.send(rawMessage);
    } catch {}
  }
}
