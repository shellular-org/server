import type http from "node:http";

import {
  createSession,
  getActiveSessionForHost,
  getSessionForSocket,
  removeSocket,
  type Session,
} from "@relay/sessions";
import { logger } from "@shared/logger";
import type { VerifiedHost } from "@shared/ws-cli-ticket";
import {
  BaseMsgSchema,
  type HostInfo,
  MsgType,
  type PongMsg,
  parseMessage,
  SessionClientJoinResultMsgSchema,
  type SessionHostedMsg,
  type SessionHostMsg,
  SessionHostMsgSchema,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { resolvePendingClient } from "./app";
import { type HostToClientMsg, HostToClientMsgSchema } from "./protocol";
import {
  CloseCodeAndReason,
  closeWsWithError,
  sendSessionErrorToClient,
  sendSessionErrorToHost,
  setupKeepAlive,
} from "./shared";

const PROXY_BINARY_MAGIC = Buffer.from("SHPB");
const PROXY_BINARY_HEADER_BYTES = 4 + 1 + 1 + 1 + 24;

/**
 * Presence callbacks so the relay can tell central which region a host is live on
 * (`host-online` / `host-offline`), which is how the app is later steered to the
 * same relay. The CLI's identity is proven by the signed host token at the WebSocket
 * upgrade (see `relay/upgrade.ts`); handleAuth then asserts the SESSION_HOST frame
 * matches that token before a session is created.
 */
export interface CliWebSocketHooks {
  /** Fired when a host session is established. Carries the full HostInfo so the
   *  relay can both report presence (uses `.id`) and capture analytics. */
  onSessionCreated?: (hostInfo: HostInfo) => void;
  onSessionClosed?: (hostId: string) => void;
}

export function initCliWebSocket(hooks: CliWebSocketHooks = {}) {
  const wsServer = new WebSocketServer({ noServer: true });
  setupKeepAlive(wsServer, "host");

  wsServer.on(
    "connection",
    (ws: WebSocket, _req: http.IncomingMessage, verifiedHost: VerifiedHost) => {
      // `verifiedHost` is the DB-verified identity from the host token, passed as
      // the 3rd `emit("connection", ...)` arg per the ws auth pattern (see
      // relay/upgrade.ts). handleAuth asserts the SESSION_HOST frame matches it.

      /**
       * Session associated with this WebSocket connection.
       * Only set after successful authentication. If null, the connection is not authenticated yet.
       */
      let session: Session | null = null;

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (!session) {
            sendSessionErrorToHost(
              ws,
              "Received binary proxy frame before authentication",
            );
            return;
          }

          relayBinaryToApp(ws, rawToBuffer(raw));
          return;
        }

        const rawStr = raw.toString();

        const parsedBase = parseMessage(rawStr, BaseMsgSchema);
        if (!parsedBase.data) {
          sendSessionErrorToClient(ws, "Invalid message format");
          return;
        }

        const parsedBaseMsg = parsedBase.data;

        if (parsedBaseMsg.type === MsgType.PING) {
          const respPongMsg: PongMsg = {
            id: `server_${nanoid(8)}`,
            type: MsgType.PONG,
            respTo: parsedBaseMsg.id,
          };
          ws.send(JSON.stringify(respPongMsg));
          return;
        }

        if (!session) {
          const msg = SessionHostMsgSchema.safeParse(parsedBaseMsg);
          if (!msg.success) {
            sendSessionErrorToHost(
              ws,
              `Received invalid message before authentication (got type: ${parsedBaseMsg.type})`,
              {
                rawStr,
                zodError: z.treeifyError(msg.error),
              },
            );
            return;
          }

          try {
            session = handleAuth(ws, msg.data, verifiedHost);
            hooks.onSessionCreated?.(session.hostInfo);
          } catch (err) {
            logger.error("Host authentication failed", err);
            const { code, reason } = CloseCodeAndReason.HOST_AUTH_FAILED;
            closeWsWithError(ws, code, reason);
            return;
          }

          return;
        }

        // Handle client approval result sent by the CLI host
        if (parsedBaseMsg.type === MsgType.SESSION_CLIENT_JOIN_RESULT) {
          const parsed =
            SessionClientJoinResultMsgSchema.safeParse(parsedBaseMsg);

          if (!parsed.success) {
            sendSessionErrorToHost(ws, "Invalid client approval message", {
              rawStr,
              zodError: z.treeifyError(parsed.error),
            });
          } else {
            const { data } = parsed.data;

            // Add the host's freshly re-checked info into the session so the
            // upcoming SESSION_JOINED handshake reflects current state for this client.
            // Stable identity (cliVersion, canSelfUpdate) lives on hostInfo; the dynamic
            // npm-lookup result (updateAvailable, latestCliVersion) lives on updateInfo.
            if (data.updateAvailable !== undefined) {
              session.updateInfo.updateAvailable = data.updateAvailable;
            }

            if (data.latestCliVersion !== undefined) {
              session.updateInfo.latestCliVersion = data.latestCliVersion;
            }

            resolvePendingClient(session.hostId, data.clientId, data.approved);
          }

          return;
        }

        // host (CLI) -> client (app) routing
        const msg = HostToClientMsgSchema.safeParse(parsedBaseMsg);
        if (!msg.success) {
          sendSessionErrorToHost(
            ws,
            `Received invalid message format (type: ${parsedBaseMsg.type})`,
            {
              rawStr,
              zodError: z.treeifyError(msg.error),
            },
          );
          return;
        }

        relayToApp(ws, msg.data);
      });

      ws.on("close", async () => {
        // Capture hostId before removeSocket clears the mapping, so the relay can
        // report the host offline. `session` is the authenticated session for this
        // socket when set.
        const closedHostId = session?.hostId;
        removeSocket(ws);
        if (closedHostId) {
          hooks.onSessionClosed?.(closedHostId);
        }
      });

      ws.on("error", () => removeSocket(ws));
    },
  );

  return wsServer;
}

function rawToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }

  return Buffer.from(raw);
}

function handleAuth(
  ws: WebSocket,
  msg: SessionHostMsg,
  verified: VerifiedHost,
): Session {
  const { id: hostId, machineId, platform } = msg.data;

  if (!hostId || !machineId || !platform) {
    throw new Error("Missing hostId, machineId, or platform");
  }

  // The host token was verified at the WS upgrade (relay/upgrade.ts) against
  // central's DB-signed claims. The relay owns no DB, so re-verify the identity
  // here against that token payload — not the DB — so a CLI holding a valid token
  // for host X can't announce itself as host Y in its SESSION_HOST frame.
  if (
    hostId !== verified.hostId ||
    machineId !== verified.machineId ||
    platform !== verified.platform
  ) {
    throw new Error(
      `SESSION_HOST identity does not match the host token (token host: ${verified.hostId})`,
    );
  }

  const existing = getActiveSessionForHost(hostId);
  if (existing) {
    throw new Error(
      `Host already has an active connection (hostId: ${hostId})`,
    );
  }

  const session = createSession(hostId, ws, msg.data);

  // complete handshake with the host (CLI)
  const hostedId = `server_${nanoid(8)}`;
  const respMsg: SessionHostedMsg = {
    type: MsgType.SESSION_HOSTED,
    data: { sessionId: session.id },
  };
  ws.send(JSON.stringify({ id: hostedId, ...respMsg }));

  return session;
}

function relayToApp(hostWs: WebSocket, msg: HostToClientMsg) {
  const entry = getSessionForSocket(hostWs);
  if (!entry) {
    sendSessionErrorToHost(hostWs, "Host is not attached to a session");
    return;
  }

  const { session } = entry;
  const clientId = msg.clientId;

  const clientInfo = session.clients.get(clientId);
  if (!clientInfo) {
    sendSessionErrorToHost(hostWs, `Client ${clientId} is not connected`);
    return;
  }

  try {
    clientInfo.ws.send(JSON.stringify(msg));
  } catch (err) {
    logger.error("Failed to relay CLI message to app", err);
    sendSessionErrorToHost(
      hostWs,
      `Failed to relay message to client ${clientId}`,
    );
  }
}

function getProxyBinaryClientId(frame: Buffer): string | null {
  if (frame.length < PROXY_BINARY_HEADER_BYTES) {
    return null;
  }

  if (!frame.subarray(0, 4).equals(PROXY_BINARY_MAGIC)) {
    return null;
  }

  const clientIdLength = frame.readUInt8(6);
  const clientIdStart = PROXY_BINARY_HEADER_BYTES;
  const clientIdEnd = clientIdStart + clientIdLength;
  if (clientIdLength === 0 || frame.length <= clientIdEnd) {
    return null;
  }

  return frame.toString("utf8", clientIdStart, clientIdEnd);
}

function relayBinaryToApp(hostWs: WebSocket, frame: Buffer) {
  const entry = getSessionForSocket(hostWs);
  if (!entry) {
    sendSessionErrorToHost(hostWs, "Host is not attached to a session");
    return;
  }

  const clientId = getProxyBinaryClientId(frame);
  if (!clientId) {
    sendSessionErrorToHost(hostWs, "Invalid binary proxy frame");
    return;
  }

  const clientInfo = entry.session.clients.get(clientId);
  if (!clientInfo) {
    sendSessionErrorToHost(hostWs, `Client ${clientId} is not connected`);
    return;
  }

  try {
    clientInfo.ws.send(frame, { binary: true });
  } catch (err) {
    logger.error("Failed to relay binary CLI frame to app", err);
    sendSessionErrorToHost(
      hostWs,
      `Failed to relay binary frame to client ${clientId}`,
    );
  }
}
