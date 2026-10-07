# VideoVector MCP Server

Official Model Context Protocol (MCP) server for VectorMethods VideoVector.

This package lets MCP clients such as Claude Desktop, Cursor, Claude Code, and custom agent runtimes search, inspect, and operate VideoVector media intelligence workflows through the public VideoVector API.

## Status

- Hosted service: Streamable HTTP with OAuth at `https://api.vectormethods.com/mcp`
- Local package transport: `stdio` with a VideoVector API key
- Self-hostable package transport: Streamable HTTP with an API key at `/mcp`
- Runtime: Node.js 18+
- Package: `@vectormethods/videovector-mcp-server`
- Command: `videovector-mcp`
- Server name: `videovector`
- MCP Registry name: `io.github.VectorMethods/videovector-mcp-server`

This repository is the public source of truth for VideoVector MCP server code, tool contracts, examples, and release metadata. Private VectorMethods backend deployment wiring, service accounts, project IDs, billing internals, and website source are intentionally not part of this repository.

## Connect to hosted VideoVector

Add `https://api.vectormethods.com/mcp` to your client's remote MCP configuration
and choose OAuth. Complete the browser sign-in with your VideoVector account,
verify your email if requested, and return to the client. No API key or local
package installation is needed for this connection. Clients discover the
authorization server and manage access-token refresh automatically.

For Cursor, use this entry in `~/.cursor/mcp.json` or your project's
`.cursor/mcp.json`, then complete the client's OAuth connection prompt:

```json
{
  "mcpServers": {
    "videovector": {
      "url": "https://api.vectormethods.com/mcp"
    }
  }
}
```

For Claude and Claude Desktop, add the URL as a custom remote connector in
**Customize → Connectors**. Choose **Register automatically** when asked how
the OAuth client identifies itself. Remote connectors use this UI; the local
JSON examples below configure stdio servers. See the current
[Claude connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
and [Cursor MCP configuration](https://cursor.com/docs/mcp).

OAuth connects the signed-in VideoVector account, including permitted create,
update, and delete operations. Product ownership, credits, and entitlements
still apply. For a deliberately limited integration, use a scoped API key.
See [hosted OAuth setup and troubleshooting](docs/hosted-oauth.md) for discovery,
custom clients, token refresh, and the available tool surface.

## Install for local stdio

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
| `VIDEOVECTOR_TOOL_PROFILE` | No | `full` | `full` keeps every advanced tool; `simple` exposes only the four workflow tools. |
| `VIDEOVECTOR_UPLOAD_ROOTS` | No | current directory | Comma-separated directories from which local stdio `upload_media` may read. |
| `MCP_TRANSPORT_MODE` | No | `stdio` | `stdio` or `http`. |

## Client Examples

- Claude Desktop: [examples/claude-desktop.json](examples/claude-desktop.json)
- Cursor: [examples/cursor.json](examples/cursor.json)
- Generic stdio: [examples/custom-stdio.json](examples/custom-stdio.json)
- Simplified workflow stdio: [examples/simple-stdio.json](examples/simple-stdio.json)
- Local Streamable HTTP: [examples/streamable-http-local.json](examples/streamable-http-local.json)

## Self-Hosted HTTP

HTTP mode is intended for self-hosted or private network deployments.
The runtime in this repository (`package.json` version `2.1.0`) authenticates
HTTP requests with API keys; it does not implement the hosted service's
OAuth verifier or discovery. To
connect using browser OAuth, use the hosted URL above. Setting OAuth
environment variables on this package does not enable that hosted behavior.

```bash
MCP_TRANSPORT_MODE=http \
VIDEOVECTOR_BASE_URL=https://api.vectormethods.com/api/v2 \
npx -y @vectormethods/videovector-mcp-server
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

The hosted VideoVector service has OAuth and protected-resource discovery
enabled. This package's API-key HTTP mode is a separate deployment choice;
see [self-hosted HTTP](docs/self-hosting-http.md). Do not advertise a
self-hosted deployment as OAuth-capable without implementing its verification
and protected-resource metadata.

## Repository tools

This section describes the local and self-hosted runtime in this repository
(`package.json` version `2.1.0`).
The hosted service has its own current tool surface, including remote media
upload; see [hosted OAuth tools](docs/hosted-oauth.md#available-tools-and-existing-api-key-clients)
and discover the available tools through your connected client.

For the lowest-friction agent workflow, set `VIDEOVECTOR_TOOL_PROFILE=simple`.
It exposes:

- `upload_media`: stream a local media file to Playground or a named/index-ID destination
- `define_prompt`: generate and, by default, save a Prompt Lab prompt
- `process_media`: process Playground, an index, or selected media with optional `content_aware` or `fixed` segmentation; omitted execution settings retain saved prompt and backend defaults
- `search_media`: vector or conditional search over Playground, an index, selected media, or prompt runs with stable cursor pagination

The default `full` profile preserves those tools plus the complete advanced
surface below. `upload_media` is local-stdio-only and is never advertised by
the Streamable HTTP transport. Its path must resolve inside
`VIDEOVECTOR_UPLOAD_ROOTS` (or the process working directory by default), and
the server streams and reopens the file for safe idempotent retries instead of
buffering it in memory.

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
