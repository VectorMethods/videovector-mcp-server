# VideoVector MCP Server

Official Model Context Protocol (MCP) server for VectorMethods VideoVector.

This package lets MCP clients such as Claude Desktop, Cursor, Claude Code, and custom agent runtimes search, inspect, and operate VideoVector media intelligence workflows through the public VideoVector API.

## Status

- Primary transport: `stdio`
- Self-hostable transport: Streamable HTTP at `/mcp`
- Runtime: Node.js 18+
- Package: `@vectormethods/videovector-mcp-server`
- Command: `videovector-mcp`
- Server name: `videovector`
- MCP Registry name: `io.github.VectorMethods/videovector-mcp-server`

This repository is the public source of truth for VideoVector MCP server code, tool contracts, examples, and release metadata. Private VectorMethods backend deployment wiring, service accounts, project IDs, billing internals, and website source are intentionally not part of this repository.

## Install

Use `npx` from your MCP client:

```bash
npx -y @vectormethods/videovector-mcp-server
```

Or install globally:

```bash
npm install -g @vectormethods/videovector-mcp-server
```

## Stdio Usage

```bash
VIDEOVECTOR_API_KEY=<your-videovector-api-key> videovector-mcp
```

Environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VIDEOVECTOR_API_KEY` | Yes for stdio | none | VideoVector API key. |
| `VIDEOVECTOR_BASE_URL` | No | `https://api.vectormethods.com/api/v2` | API base URL. |
| `VIDEOVECTOR_TIMEOUT` | No | `90000` | Request timeout in milliseconds. |
| `VIDEOVECTOR_MAX_RETRIES` | No | `3` | Retry count for retryable API failures. |
| `MCP_TRANSPORT_MODE` | No | `stdio` | `stdio` or `http`. |

## Client Examples

- Claude Desktop: [examples/claude-desktop.json](examples/claude-desktop.json)
- Cursor: [examples/cursor.json](examples/cursor.json)
- Generic stdio: [examples/custom-stdio.json](examples/custom-stdio.json)
- Local Streamable HTTP: [examples/streamable-http-local.json](examples/streamable-http-local.json)

## Self-Hosted HTTP

HTTP mode is intended for self-hosted or private network deployments.

```bash
npm run build
MCP_TRANSPORT_MODE=http \
VIDEOVECTOR_BASE_URL=https://api.vectormethods.com/api/v2 \
node dist/index.js
```

Endpoints:

- `GET /health`
- `POST /mcp`

The `/mcp` endpoint is stateless. Each POST is independent and may be routed
to any healthy instance. `GET /mcp` and `DELETE /mcp` return `405`; clients
must not send or persist `MCP-Session-Id`.

HTTP requests must include either:

- `Authorization: Bearer <your-videovector-api-key>`
- `X-API-Key: <your-videovector-api-key>`

HTTP hardening variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind host. |
| `MCP_HTTP_ALLOWED_HOSTS` | empty | Optional comma-separated host allowlist. |
| `MCP_HTTP_ALLOWED_ORIGINS` | empty | Optional comma-separated browser origin allowlist. |
| `MCP_HTTP_ENABLE_JSON_RESPONSE` | `false` | SDK JSON response mode. |
| `MCP_HTTP_SHUTDOWN_DRAIN_SECONDS` | `25` | Maximum graceful drain before active request contexts are closed. |

Both stdio and HTTP modes accept canonical production keys only (`sk_live_` followed by
exactly 48 lowercase hexadecimal characters). Invalid candidates are rejected
before normal API use. In HTTP mode, validation uses the side-effect-free
`GET /auth/validate` API operation. Successful keys are cached for 60 seconds,
confirmed invalid keys for 10 minutes, and transient failures for five
seconds. Same-key checks are singleflighted and backend validation is bounded
to 16 concurrent calls plus a 64-request queue with a five-second timeout.
Plaintext keys are never written to caches or logs. When both supported HTTP
headers are present, `X-API-Key` takes precedence, matching the VideoVector
API.

Do not advertise a public hosted remote MCP endpoint until OAuth and MCP protected-resource metadata are enabled for that deployment.

## Tools

The server exposes tools for:

- semantic, image, multimodal, and structured metadata search
- index, video, segment, and prompt discovery
- prompt-run estimation, execution, status, results, retries, and cancellation
- prompt management and schema testing
- cloud connectors, import jobs, exports, and webhooks

The machine-readable tool contract is generated at [artifacts/tool-contract.json](artifacts/tool-contract.json). Private backend and website releases should vendor this artifact for MCP helper endpoints and documentation updates.

`get_export_status` is side-effect free: its `download_url` is only the
authenticated API endpoint and it never mints a bearer credential. Use the
separate `get_export_download_url` tool only when a header-free client
explicitly needs a short-lived bounded URL. Connector-delivered, processing,
failed, and otherwise unavailable exports return `download_url: null`. Treat
any non-null minted URL as a credential and do not log or persist it.

## Development

```bash
npm ci
npm run verify
```

Useful scripts:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run generate:contract`
- `npm run check:contract`
- `npm run check:examples`

Use the MCP Inspector for local manual checks:

```bash
npx @modelcontextprotocol/inspector
```

For stdio, point the Inspector to `npx -y @vectormethods/videovector-mcp-server` and set `VIDEOVECTOR_API_KEY`.

## Security

Never commit API keys, cloud credentials, connector credentials, webhook secrets, service-account JSON, or `.env` files.

See [SECURITY.md](SECURITY.md) for supported versions, disclosure instructions, and operational guidance.
