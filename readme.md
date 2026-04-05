# shellular-server

> WebSocket relay server for [Shellular](https://shellular.foxbiz.io) — bridges the CLI host agent and the Acode client plugin without requiring inbound connectivity on either side.

---

## What It Does

The server acts as a stateless relay:

1. A **CLI host** connects via WebSocket and sends `session:host` → receives a short 8-character **session token**.
2. An **Acode client** connects using that token, either via WebSocket (`session:join`) or via HTTP polling (`POST /api/session/join`).
3. All subsequent messages are **relayed transparently** between the two sides. The server never interprets terminal or filesystem payloads.
4. A SQLite database (`~/.shellular/shellular.db`) is initialized on startup for future persistent features; no data is stored there currently.

---

## Requirements

- Node.js 18+
- pnpm

---

## Development

### Install

```bash
cd server
pnpm install
```

### Run (watch mode)

```bash
pnpm run dev
```

Server listens on `0.0.0.0:3000` by default.

### Run (one-shot)

```bash
pnpm start
```

### Environment Variables

| Variable      | Default | Description                                |
| ------------- | ------- | ------------------------------------------ |
| `PORT`        | `3000`  | TCP port to listen on                      |
| `CORS_ORIGIN` | `*`     | `Access-Control-Allow-Origin` header value |

Create a `.env` file in `server/` to override defaults (see [.env.example](.env.example)):

```env
PORT=3000
CORS_ORIGIN=https://shellular.foxbiz.io
```

---

## Project Layout

```
server/
├── src/
│   ├── main.ts              Entry point — Express app, HTTP polling endpoints, server bootstrap
│   ├── config.ts            App directory / DB path constants; creates ~/.shellular/ on startup
│   ├── api/
│   │   └── v1/index.ts      v1 API router (extensible; currently empty)
│   ├── middleware/
│   │   ├── cors.ts          CORS headers middleware (CORS_ORIGIN env var)
│   │   └── authenticate.ts  Auth middleware stub (passthrough)
│   ├── utils/
│   │   └── db.ts            SQLite setup via better-sqlite3; schema migration helpers
│   └── websocket/
│       ├── index.ts         WebSocket server init; auth handshake + message relay
│       └── sessions.ts      In-memory session store — hosts, WS clients, HTTP clients, terminal buffers
├── public/
│   ├── index.html           Landing page served at /
│   └── scanner.html         QR scanner helper page
├── package.json
└── tsconfig.json
```

---

## API Reference

### WebSocket

Connect to `ws://<host>:<port>`. First message must authenticate:

| First message type | Payload                       | Response                          |
| ------------------ | ----------------------------- | --------------------------------- |
| `session:host`     | `{ hostname, platform, dir }` | `session:hosted` → `{ token }`    |
| `session:join`     | `{ token }`                   | `session:joined` → `{ hostInfo }` |

After auth, all messages are relayed to the other side verbatim.

---

### HTTP (polling fallback)

Used by the Acode client when a persistent WebSocket is not available.

#### `POST /api/session/join`

Join a session and get a polling identity.

**Body:** `{ token: string }`

**Response:** `{ clientId: string, hostInfo: { hostname, platform, dir } }`

---

#### `POST /api/exchange`

Send messages to the host and receive queued messages from the host.

**Body:** `{ clientId: string, outgoing: Message[] }`

**Response:** `{ messages: Message[] }`

The client should poll this endpoint repeatedly (adaptive 50–1000 ms interval).

---

#### `POST /api/terminal/buffer`

Fetch and clear the cached terminal scrollback buffer for a given terminal.

**Body:** `{ clientId: string, terminalId: string }`

**Response:** `{ buffer: string }`

---

#### `GET /health`

Returns `200 OK`. Used for uptime monitoring.

---

## Session Lifecycle

```
CLI                 Server                 Acode client
 │  session:host ──▶│                           │
 │◀─ session:hosted  │                           │
 │                  │◀── POST /api/session/join ─│
 │◀─ session:client-joined                       │
 │                  │◀── POST /api/exchange ─────│
 │◀─────── relay ───│──────────── relay ─────────│
```

Sessions are **in-memory** — a server restart clears all active sessions.

Terminal scrollback buffers (up to 100 KB per terminal) are held server-side and cleaned up after 7 days of inactivity or on explicit fetch.

---

## Links

- Live relay: [https://shellular.foxbiz.io](https://shellular.foxbiz.io)
- CLI host agent: [../cli/readme.md](../cli/readme.md)
- Acode plugin: install **Shellular** from the Acode plugin marketplace
- Issues / feedback: [contact@foxbiz.io](mailto:contact@foxbiz.io)
