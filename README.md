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
| `VIDEOVECTOR_TOOL_PROFILE` | No | `full` | `simple` exposes find, uploads, processing, search, and their status/results tools. |
| `VIDEOVECTOR_UPLOAD_ROOTS` | No | current directory | Comma-separated directories from which local stdio `upload_media` may read. |
| `MCP_UPLOAD_API_BASE_URL` | No | API base URL | Public upload API base including `/api/v2`; must match the backend upload URL configuration and picker CSP. |
| `MCP_APP_BASE_URL` | No | `https://app.vectormethods.com` | HTTPS app origin for authenticated playback, JSON, and export links. |
| `MCP_TRANSPORT_MODE` | No | `stdio` | `stdio` or `http`. |

## Client Examples

- Claude Desktop: [examples/claude-desktop.json](examples/claude-desktop.json)
- Cursor: [examples/cursor.json](examples/cursor.json)
- Generic stdio: [examples/custom-stdio.json](examples/custom-stdio.json)
- Simplified workflow stdio: [examples/simple-stdio.json](examples/simple-stdio.json)
- Local Streamable HTTP: [examples/streamable-http-local.json](examples/streamable-http-local.json)

## Self-Hosted HTTP

HTTP mode is intended for self-hosted or private network deployments.

The commands and settings below apply to this package and its source.
Install dependencies with `npm ci` before building from source.

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
the main API to cold-start. Calls to `upload_media`, `process_media`, `find`, and
`retry_prompt_run_segment` also signal processing intent before backend work.
The server owns event receipts, coalescing and readiness windows (15 minutes
for LOW, 30 minutes for API).

These requests are advisory, bounded to three seconds (or the configured
shorter timeout), and never automatically retried. Failure does not change
authentication or tool results. An acknowledgement is not proof that startup
has completed. Read-only credential validation, its cache refresh, token
refresh, discovery, status polling, imports and ordinary reads do not send
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

For the lowest-friction agent workflow, set `VIDEOVECTOR_TOOL_PROFILE=simple`.
It exposes:

- `find`: upload attached videos, generate schemas and optional filters together, and start one fresh Playground execution
- `upload_media`: import native attachments, local stdio files, or files chosen in the inline picker
- `define_prompt`: generate extraction schemas and optional selection filters in one call, saving the prompt by default
- `process_media`: start an asynchronous execution for Playground, an index, or selected media; saved engine execution settings apply unless explicitly overridden
- `search_media`: vector, conditional, or combined search over Playground, an index, selected media, or prompt runs with stable cursor pagination
- `get_prompt_run_status`: poll execution progress and selection readiness
- `get_prompt_run_results`: read filtered matches and unfiltered extraction with independent bounded pages
- `get_import_job`: follow upload progress and obtain the downstream execution ID
- `retry_import_job`: resume a failed attachment job using its staged files

`process_media` replaces the former `execute_prompt` tool. Its optional overrides
are `video_segmentation_type`, `audio_segmentation_type`,
`video_segment_duration`,
`audio_segment_duration`, `processing_model`,
`enable_transcription`, and `enable_image_embedding`. Omit settings to retain
the saved engine defaults in both indexed media and Playground. Null overrides
also inherit. Video and audio support `content_aware` (the default) and `fixed`
segmentation. Fixed mode requires its corresponding duration in integer seconds
from 1 to 300. `define_prompt` preserves supported segmentation intent
qualitatively in the generated instructions. Save engine settings through
`create_prompt`/`update_prompt` under `execution_config`.

The default `full` profile adds the advanced surface below. Both transports
accept native attachment descriptors. Local `file_path` (`upload_media`) and
`file_paths` (`find`) shortcuts are advertised only over stdio, require allowed
upload roots, and stream files into the same intake job.

`find` accepts an instruction and the videos attached to that command. It
disables advanced transcription and image embeddings, uses content-aware segmentation, and returns a durable
job ID immediately for native attachments. Poll `get_import_job`, then the run's
status and both result pages. Each new command starts fresh; retain one
idempotency key only when retrying that command.

`retry_import_job` reuses the uploaded files. A known wizard failure starts a
new generation attempt; a successful generation is reused. An uncertain
generation outcome returns a conflict instead of silently generating again.

If a host cannot forward video attachments, omitting `files` opens the MCP Apps
picker in the conversation. The picker sends bytes directly to the configured
upload API using a job-scoped capability delivered only in private `_meta`.
Clients without MCP Apps can use native attachments or the local stdio shortcuts.

The nine workflow tools return compact version 2 summaries with authenticated
app links and automatic JSON export status. Use `detail=full` on definition,
processing, status, or result tools only when the model needs the full payload.
`get_prompt_run_results` and `search_media` can display an optional MCP Apps card
for playback, result browsing, and JSON inspection. The card keeps media grants
and full metadata outside model-visible tool output. Other clients receive the
same links and bounded summaries. See [the result contract](docs/tool-contract.md#workflow-results-version-2).

The Studio can browse every Playground video, scope searches to individual videos, and select an execution as a visual group. Search results open in the player with a result carousel and the selected execution’s complete segment strip. Back navigation retains the search, and supported hosts restore navigation from private widget state using frozen snapshot reads. Semantic queries can be combined with conditions; combined filters apply to the existing ranked window of up to 100 candidates, not the entire corpus. Conditional-only searches use the canonical metadata engine.

The card preselects the current run result and preloads paused playback. Search tools open the result grid. Its formatted
analysis and segment strip reuse the application's presentation components;
The standalone UI components and utilities are included under `ui/components`
and `ui/utils`; `npm run build` bundles both embedded apps for distribution.

For an existing ChatGPT connection that returns links without the card, open
VideoVector's app settings, choose **Refresh tools**, then request the results
again. ChatGPT retains discovered tool metadata from earlier connections.

The server exposes tools for:

- semantic, image, multimodal, and structured metadata search
- index, video, segment, and prompt discovery
- prompt-run estimation, execution, status, results, retries, and cancellation
- prompt management and schema testing
- cloud connectors, import jobs, exports, and webhooks

The machine-readable tool contract is generated at [artifacts/tool-contract.json](artifacts/tool-contract.json). Private backend and website releases should vendor this artifact for MCP helper endpoints and documentation updates.

`get_export_status` is side-effect free: its `download_url` is only the
authenticated API endpoint and it never mints a bearer credential. Present
`links.open_in_app` and, when ready, `links.download_json` to users; these open
the existing export card and authenticated download in their signed-in app.
Use the
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

### Expired attachment links

`get_import_job` returns per-file failure codes, HTTP status when available, and
`refresh_required`. `retry_import_job` reuses imported and staged files. Supply
its optional `files` with fresh host-provided download descriptors only for the
unfinished, unstaged file IDs that need refresh. Keep their original file IDs,
filenames and MIME types; use a new idempotency key when descriptors change.
`cancel_import_job` can discard retained unfinished files from a failed attachment
job while keeping imported media. Signed download links never appear in tool output.

## Standalone parts and grounded extraction

Uploads return durable import jobs. Long videos become the minimum number of
balanced standalone parts, each at most 40 minutes. Each part has its own media
ID, local timestamps, segments and optional whole-media output. Job phase and
source-file counters are separate from `parts_total`, `parts_completed`, and
`parts_failed`. Read every ordered outputs page (`next_cursor` until null).
`video_ids` includes only the current page. Use `import_job_id` with processing
to select the complete completed import, exclusive with `video_ids`.

The optional `video_level` configuration contains only `instructions_text` and
`json_schema`. It requires content-aware segmentation. Segment and whole-media
fields are returned in the same media call, grounded directly in the supplied
part; there is no later segment-text synthesis or cross-part summary.
