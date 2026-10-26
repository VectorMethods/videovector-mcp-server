# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not
durably persist API keys, connector credentials, webhook secrets, or cloud
credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

Local path shortcuts exist only in stdio mode. They canonicalize the source
and allowed roots with `realpath`, rejects files outside
`VIDEOVECTOR_UPLOAD_ROOTS` (the current working directory by default), requires
a supported regular media file, and rechecks its device, inode, and size after
opening without following a final symlink. Multipart bodies are streamed; a
retry reopens the file and reuses one backend idempotency key.

## Streamable HTTP

In HTTP mode, protected tool calls authenticate with exactly one credential: a
VideoVector API key or, when enabled, a WorkOS OAuth bearer token. OAuth
publication permits initialization and tool discovery before sign-in so clients
can discover the authorization requirement; this does not permit protected tool
execution. Mixed credentials are rejected. The transport is stateless: no session identifier,
credential, or server object is retained after the response closes. This
allows requests to move safely across instances and restarts.

HTTP tool listings expose native `files` inputs for `analyze` and `import_media`.
Local path fields are omitted and rejected at execution, so a remote caller
cannot cause the server to read a local filesystem path.

When files cannot be forwarded, the MCP Apps picker receives an upload grant
only through private tool-result `_meta`. Neither JSON text nor structured
content contains this capability. The picker and stdio adapter send it only to
the configured upload API; account credentials are not forwarded with it.
The UI resource declares that exact origin in its CSP. The upload API must allow
the host's sandbox origin in CORS. Jobs continue in the backend after tool calls
close, and completion names the exact selected file IDs.

Workflow summaries use reviewed public envelopes for every authentication
method. Raw media locations and storage paths are absent from model-visible
results; user-authored extracted metadata remains opaque data. Analysis JSON and
segment download links are intentional first-party, one-hour bearer capabilities.
Segment delivery validates current access and exact snapshot membership before
redirecting to the canonical generation-pinned storage download. Agents follow
that redirect without forwarding account credentials. App navigation links stay
under the configured app origin.

The results card requests existing pages and media by ID through the authenticated
MCP connection. App-only visibility is a host UI instruction, not authorization:
the backend still enforces tenant ownership and run/segment membership. Media
Playback grants appear only in `_meta.media`, and full card rows in `_meta.view`.
Direct analysis segment downloads also appear in the model response and JSON.
Account OAuth/API credentials never enter the iframe. The card does not call
`updateModelContext` or send extracted JSON into chat. Its CSP allows media only
from declared Google Cloud Storage origins and no fetch/XHR origins.

For API-key requests, before an MCP request context is allocated the server validates the key with
the API's side-effect-free authentication endpoint. Validation caches and
singleflight coordination use a process-secret HMAC fingerprint rather than
plaintext credentials. Backend validation concurrency and queue depth are
bounded independently of client IP, so one shared proxy cannot deny valid
tenants admission merely by presenting other credentials.

WorkOS access tokens are verified offline with `jose`. The verifier accepts
only RS256, the exact configured issuer, an audience containing only the
canonical MCP resource, bounded time skew, and signed `sub`, `sid`, `jti`, and
Firebase UID identities. The JWKS resolver has bounded fetch time, cooldown,
and cache age; repeated unknown key IDs cannot force one WorkOS request per MCP
request. JWKS outages are service failures, not invalid-token relinking events.
Health checks never fetch JWKS.

OAuth authorizes the linked account's tenant operations, including tenant-admin
operations, while Firebase-session-only, API-key-management, platform-admin,
and internal-service routes remain unavailable. Token scope claims are not used
for product authorization; legacy API-key scope behavior is unchanged. The original bearer is forwarded to the API, while issuer,
subject, and resource form the stable idempotency principal. Raw rotating
tokens are never used as idempotency identities. UserInfo and per-request
introspection are not called.

When OAuth metadata is advertised, hosted tool definitions carry identical
top-level and compatibility-mirror `oauth2` schemes with empty scope arrays.
Only precise backend OAuth-token 401 errors trigger relinking metadata.
Authorization, ownership, plan, billing, quota, and availability failures do
not become OAuth prompts. Stdio definitions and API-key scopes are unchanged.

HTTP mode has optional host and origin allowlists:

- `MCP_HTTP_ALLOWED_HOSTS`
- `MCP_HTTP_ALLOWED_ORIGINS`

## Credential-sensitive options

Direct API-key/stdio integrations may supply cloud source configuration or a task callback signing secret to `analyze`/`import_media`. The MCP server forwards these only to the configured first-party API and does not persist or log them. Callbacks are terminal-only and scoped to the submitted task. Use least-privilege credentials and protect the caller's signing secret.

OAuth exposes the same six names while omitting cloud source and webhook arguments. Runtime schema validation rejects excluded options before backend dispatch. Analysis/search downloads remain authorized one-hour result capabilities. They are scoped to a captured snapshot and separate from private account credentials and upload grants. Generic download clients fetch them without forwarding OAuth headers. Export administration remains outside MCP.

See [hosted OAuth](hosted-oauth.md#available-tools-and-existing-api-key-clients).
