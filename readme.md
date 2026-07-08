# Shellular Server

WebSocket relay server for [Shellular](https://shellular.dev) — relays messages between Shellular CLI host agent and the Shellular app client.

## Requirements

- Node.js 18+
- pnpm

## Development

### Install

```bash
pnpm install
```

### Environment

Create a local `.env` from `.env.example`. The server requires `WS_TOKEN_SECRET` with at least 32 characters for signing short-lived app WebSocket tickets.

OAuth provider settings live in `.env`. Apple Sign in with Apple uses `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, and `APPLE_KEY_ID`, and reads the private key from the ignored `apple_key.p8` file in the server directory.

### Run (watch mode)

```bash
pnpm run dev
```

Server listens on `0.0.0.0:3000` by default.

### Run (one-shot)

```bash
pnpm start
```

## OAuth Login

See [docs/oauth-flow.md](docs/oauth-flow.md) for provider setup, token lifecycle, and the app/WebSocket authentication flow.

## App WebSocket Authentication

The app no longer sends access tokens or device metadata in the `/app` WebSocket URL. Instead:

1. The app refreshes its access token.
2. The app sends `POST /auth/ws-token` with `Authorization: Bearer <accessToken>` and client metadata in the JSON body.
3. The server validates the user token, `ClientInfoSchema`, host existence, and known-client identity.
4. The server returns a signed app WebSocket ticket that expires after 30 seconds.
5. The app opens `/app?wsToken=<ticket>`.

The `/cli` WebSocket and `/host/register` flow are unchanged.

## User History

Successful app joins are recorded in `user_connection_history` for read-only account history. `GET /auth/history` returns the authenticated user's host and device history for display in the app. This data is intended for visibility, history, and analytics only; it is not used for host sync or E2EE key sync.

## App Notices

Short, dismiss-once messages shown as a popup on the app home screen (e.g. maintenance heads-ups). Notices are served from a plain JSON file so they can be pushed to already-installed apps without an app update.

**How it works**

- Notices live in `content/notices.json`.
- The server reads that file into memory on boot and re-reads it about once an hour, so edits show up in the app without a redeploy or restart. A malformed edit keeps the previous cache rather than taking the endpoint down.
- `GET /notices` returns the cached notices; the app fetches this and shows the first notice the user hasn't dismissed.
- Each notice has a stable `id`. The app remembers which ids a user dismissed, so a dismissed notice never reappears — but adding a **new** notice (new id) pops up for everyone. To push a fresh message, add a new notice.

**Managing notices**

Use the `notices` CLI rather than hand-editing the JSON — it owns id generation so ids are never typed by hand.

```bash
# List all notices
pnpm notices list

# Add a notice interactively — prompts for title and body (id is generated automatically)
pnpm notices add

# Add a notice non-interactively with flags
pnpm notices add --title "Heads up" --body "Some message"

# Edit an existing notice's title and/or body
pnpm notices edit <id> --title "New title" --body "New body"

# Remove a notice
pnpm notices rm <id>
```

Changes take effect the next time the server re-reads the file (within ~1 hour), or immediately on restart.

## License

AGPL-3.0-only

## Links

- CLI host agent: [https://www.npmjs.com/package/shellular](https://www.npmjs.com/package/shellular)
- Issues / feedback: [team@shellular.dev](mailto:team@shellular.dev)
