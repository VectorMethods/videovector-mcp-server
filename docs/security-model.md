# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not
durably persist API keys, connector credentials, webhook secrets, or cloud
credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

The `upload_media` tool exists only in stdio mode. It canonicalizes the source
and allowed roots with `realpath`, rejects files outside
`VIDEOVECTOR_UPLOAD_ROOTS` (the current working directory by default), requires
a supported regular media file, and rechecks its device, inode, and size after
opening without following a final symlink. Multipart bodies are streamed; a
retry reopens the file and reuses one backend idempotency key.

## Self-hosted Streamable HTTP

In this repository runtime (`package.json` version `2.1.1`), every HTTP MCP
POST authenticates with a VideoVector API key, including initialization and
tool discovery. OAuth authentication is not implemented by this package.
The transport is stateless: no session identifier, API key, or server object
is retained after the response closes. This allows requests to move safely across
instances and restarts.

HTTP tool listings omit `upload_media`; a remote MCP caller cannot cause the
server to read a local filesystem path.

Before an MCP request context is allocated, the server validates the key with
the API's side-effect-free authentication endpoint. Validation caches and
singleflight coordination use a process-secret HMAC fingerprint rather than
plaintext credentials. Backend validation concurrency and queue depth are
bounded independently of client IP, so one shared proxy cannot deny valid
tenants admission merely by presenting other credentials.

HTTP mode has optional host and origin allowlists:

- `MCP_HTTP_ALLOWED_HOSTS`
- `MCP_HTTP_ALLOWED_ORIGINS`

## Credential-Sensitive Tools

Cloud connector creation tools accept user-provided cloud credentials and forward them to the VideoVector API. The MCP server does not persist them. Users should provide least-privilege credentials and rotate them according to their own cloud policy.

## Hosted OAuth service

The service at `https://api.vectormethods.com/mcp` supports browser OAuth
account linking independently of this package's API-key HTTP mode. See
[hosted OAuth](hosted-oauth.md) for client setup, discovery, and token refresh.
Initialization and tool discovery may run before sign-in; protected tool calls
require exactly one valid API-key or OAuth credential. Mixed credentials are
rejected by the hosted service.

OAuth authorizes the linked account's tenant operations, including permitted
tenant administration and deletion. Ownership, billing, quota, and
entitlements remain authoritative. The grant does not permit API-key
management, platform administration, or Firebase-session-only and
internal-service routes. OAuth identity scopes do not map to the
`read`, `write`, `search`, or `admin` permissions of API keys.

Cloud connector creation tools, `create_webhook`, and
`get_export_download_url` are excluded from the hosted OAuth tool surface.
They remain available to existing API-key clients. Configure connectors and
webhooks in VideoVector and use authenticated app links for OAuth exports.

Keep OAuth access and refresh tokens in the MCP client's credential store.
Do not include them in prompts, URLs, repository configuration, or tool inputs.
