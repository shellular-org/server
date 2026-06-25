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

## License

AGPL-3.0-only

## Links

- CLI host agent: [https://www.npmjs.com/package/shellular](https://www.npmjs.com/package/shellular)
- Issues / feedback: [team@shellular.dev](mailto:team@shellular.dev)
