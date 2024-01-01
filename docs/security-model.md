# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not
durably persist API keys, connector credentials, webhook secrets, or cloud
credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

## Streamable HTTP

In HTTP mode, every MCP POST authenticates with a VideoVector API key. The
transport is stateless: no session identifier, API key, or server object is
retained after the response closes. This allows requests to move safely across
instances and restarts.

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
