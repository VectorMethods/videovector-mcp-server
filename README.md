# VideoVector MCP Server

Official Model Context Protocol (MCP) server for VectorMethods VideoVector.

This package lets MCP clients such as Claude Desktop, Cursor, Claude Code, and custom agent runtimes search, inspect, and operate VideoVector media intelligence workflows through the public VideoVector API.

## Status

- Hosted transport: Streamable HTTP with OAuth at `https://api.vectormethods.com/mcp`
- Local transport: `stdio` with a VideoVector API key
- Self-hostable transport: Streamable HTTP at `/mcp`
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
the OAuth client identifies itself. Remote connectors use this UI; the desktop
JSON file below configures local stdio servers. See the current
[Claude connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
and [Cursor MCP configuration](https://cursor.com/docs/mcp).

OAuth connects the signed-in VideoVector account to the six published media
tools. MCP exposes no deletion or administration tools. Product ownership,
credits, and entitlements still apply. For narrower integration permissions,
use a scoped API key.
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
| `VIDEOVECTOR_UPLOAD_ROOTS` | No | current directory | Comma-separated directories from which local stdio `analyze` or `import_media` may read. |
| `MCP_UPLOAD_API_BASE_URL` | No | API base URL | Public upload API base including `/api/v2`; must match the backend upload URL configuration and picker CSP. |
| `MCP_APP_BASE_URL` | No | `https://app.vectormethods.com` | HTTPS app origin for authenticated playback, JSON, and export links. |
| `MCP_TRANSPORT_MODE` | No | `stdio` | `stdio` or `http`. |

## Client Examples

- Claude Desktop: [examples/claude-desktop.json](examples/claude-desktop.json)
- Cursor: [examples/cursor.json](examples/cursor.json)
- Generic stdio: [examples/custom-stdio.json](examples/custom-stdio.json)
- Local Streamable HTTP: [examples/streamable-http-local.json](examples/streamable-http-local.json)

## Self-Hosted HTTP

HTTP mode is intended for self-hosted or private network deployments.

The commands and settings below apply to this checked-out server source.
Install its dependencies with `npm ci` before building. For the published npm
package's API-key HTTP mode and supported settings, follow the
[public package README](https://github.com/VectorMethods/videovector-mcp-server#self-hosted-http).

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

Protected HTTP tool requests use exactly one of:

- `Authorization: Bearer <your-videovector-api-key>`
- `X-API-Key: <your-videovector-api-key>`
- `Authorization: Bearer <workos-access-token>` when OAuth is enabled

HTTP hardening variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind host. |
| `MCP_HTTP_ALLOWED_HOSTS` | empty | Optional comma-separated host allowlist. |
| `MCP_HTTP_ALLOWED_ORIGINS` | empty | Optional comma-separated browser origin allowlist. |
| `MCP_HTTP_ENABLE_JSON_RESPONSE` | `false` | SDK JSON response mode. |
| `MCP_HTTP_SHUTDOWN_DRAIN_SECONDS` | `25` | Maximum graceful drain before active request contexts are closed. |
| `MCP_OAUTH_ENABLED` | `false` | Verify WorkOS OAuth bearer tokens for hosted HTTP requests. |
| `MCP_OAUTH_METADATA_ENABLED` | `false` | Advertise OAuth tool security metadata and path-aware authentication challenges. Requires OAuth verification. |
| `MCP_OAUTH_ISSUER` | empty | Canonical HTTPS WorkOS issuer origin. Required when OAuth is enabled. |
| `MCP_OAUTH_JWKS_URL` | empty | Exact `<issuer>/oauth2/jwks` HTTPS endpoint. Required when OAuth is enabled. |
| `MCP_OAUTH_RESOURCE` | empty | Exact canonical HTTPS MCP resource URL with a path, such as `https://api.vectormethods.com/mcp`. Required when OAuth is enabled. |
| `MCP_OAUTH_CLOCK_SKEW_SECONDS` | `60` | JWT clock tolerance, from 0 through 300 seconds. |

API-key authentication in both stdio and HTTP modes accepts canonical production keys only (`sk_live_` followed by
exactly 48 lowercase hexadecimal characters). Invalid candidates are rejected
before normal API use. In HTTP mode, validation uses the side-effect-free
`GET /auth/validate` API operation. Successful keys are cached for 60 seconds,
confirmed invalid keys for 10 minutes, and transient failures for five
seconds. Same-key checks are singleflighted and backend validation is bounded
to 16 concurrent calls plus a 64-request queue with a five-second timeout.
Plaintext keys are never written to caches or logs. Requests that combine
`X-API-Key` and `Authorization` are rejected as ambiguous.

Authenticated HTTP initialization and a local stdio session's initialized
notification send one explicit `POST /auth/processing-activity` using the same
credential. The control service starts API and LOW capacity without waiting for
the main API to cold-start. New `import_media` and `analyze` submissions
also signal processing intent before backend work.
The server owns event receipts, coalescing and readiness windows (15 minutes
for LOW, 30 minutes for API).

These requests are advisory, bounded to three seconds (or the configured
shorter timeout), and never automatically retried. Failure does not change
authentication or tool results. An acknowledgement is not proof that startup
has completed. Read-only credential validation, its cache refresh, token
refresh, discovery, status polling and ordinary reads do not send
readiness activity.

OAuth access tokens are verified locally with the pinned WorkOS issuer,
resource audience, and process-cached JWKS. Verification requires RS256,
standard time claims, subject/session/JWT identifiers, and the signed Firebase
UID claim. The same bearer token is forwarded to the VideoVector API; the MCP
service does not call UserInfo, introspection, or mint an internal token.
OAuth represents the signed-in Firebase account and therefore does not use the
legacy `search`, `read`, or `write` API-key scopes. Account ownership, plan,
billing, and entitlement checks remain authoritative in the API.

Set `MCP_OAUTH_ENABLED=true` first while keeping metadata hidden. Enable
`MCP_OAUTH_METADATA_ENABLED` only after the protected-resource metadata is
available at `/.well-known/oauth-protected-resource/mcp` on the public resource
origin. The API service owns that public metadata route in the hosted
deployment; this Node service owns `/mcp` authentication and challenges.

The hosted VectorMethods deployment routes HTTPS through a Cloud Armor-backed
external load balancer and restricts Cloud Run ingress to
`internal-and-cloud-load-balancing`. Its coarse edge default is 600 requests
per minute per source IP; application and backend key/capacity controls remain
authoritative. A public deployment must not expose its direct `run.app`
origin.

The hosted endpoint above has OAuth verification and discovery enabled. These
deployment settings apply when operating your own server; see
[self-hosted HTTP](docs/self-hosting-http.md).

## Tools

One six-tool catalog is shared by stdio, API-key HTTP, and OAuth:

| Tool | Purpose |
| --- | --- |
| `analyze` | Analyze root native `files` or one nested `source`, using `instruction` or `prompt_id`. |
| `get_analysis` | Read one analysis or the latest complete analysis for a video. |
| `search` | Combine text, image, and metadata filters in one nested `scope`; resume saved snapshots. |
| `import_media` | Import without analysis, inspect `import_id`, or retry failures where supported. |
| `save_prompt` | Generate/save a prompt from instruction or an explicit definition. |
| `browse` | Discover indexes, videos, analyses, imports, or prompts with resource-specific filters. |

There are no Simple/Full profiles or retired-name aliases. OAuth omits cloud source credentials, cloud import, import retry, and webhook arguments while keeping the same six names. Direct integrations can supply terminal-only task callbacks. Local paths are nested under `source.file_paths` and appear only on stdio. All schemas include conditional rules and examples; see the [hierarchical contract](docs/tool-contract.md) and [generated JSON Schema](artifacts/tool-contract.json).

Analysis retains one durable ID across upload and processing. Observations wait at most 30 seconds; local transfers use the configured request timeout. Typed `next_action` distinguishes required input, progress, results, and errors. Continue observing within host/user controls, preserving the ID and retry identity. Pending does not mean stuck.

Complete-video JSON appears incrementally through included one-hour download grants. The response and JSON also contain direct segment downloads. Fetch these capabilities without OAuth headers; refresh through the same result tool without rerunning or creating an export. Save JSON where the host supports files and retain its path for context recovery. Hosts without filesystem tools can use bounded full-detail pages.

Every new search requires an explicit scope. Search filters candidates before ranking; library/video/Playground scopes use latest complete results per video. `scope.analysis_ids` selects history. Use `search_id` with an optional cursor to resume the same saved snapshot without rerunning. The shared Studio supports native upload, visible progress polling, playback, and JSON inspection through private app-only helpers. Native REST APIs remain available independently.

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

### Failed imports

Read `import_media` with the original `import_id` for safe per-file errors and progress. Direct integrations can retry failed work with `retry:true` and an explicit idempotency key. OAuth users review failures in the app. Never invent fresh attachment descriptors or restart successful work because a read timed out.

## Standalone parts and grounded extraction

Uploads return durable import jobs. Long videos become the minimum number of
balanced standalone parts, each at most 40 minutes. Each part has its own media
ID, local timestamps, segments and optional whole-media output. Job phase and
source-file counters are separate from `parts_total`, `parts_completed`, and
`parts_failed`. Read every ordered outputs page (`next_cursor` until null).
`video_ids` includes only the current page. Use `analyze` with `source.import_id`
to select the complete completed import; it is exclusive with other source selectors.

The optional `video_level` configuration contains only `instructions_text` and
`json_schema`. It requires content-aware segmentation. Segment and whole-media
fields are returned in the same media call, grounded directly in the supplied
part; there is no later segment-text synthesis or cross-part summary.
