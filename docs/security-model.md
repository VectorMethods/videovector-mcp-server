# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not
durably persist API keys, connector credentials, webhook secrets, or cloud
credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

## Streamable HTTP

In HTTP mode, every MCP request must authenticate with a canonical production
VideoVector API key. Sessions retain the key in process memory only while it is
needed to call the API and are bound to a one-way hash of the initialization
key, so a session cannot be reused with another key. Per-key and process session
caps plus idle and absolute expiry bound abandoned-session capacity.

Before allocating a session, the HTTP transport validates the key format and
performs one backend verification attempt. Positive, negative, and transient
results are cached only by one-way key hash. Distinct uncached candidates are
bounded per direct network peer and process; untrusted forwarding headers are
not used as identity. Verification errors are logged by status/code, never by
backend response text.

HTTP mode has optional host and origin allowlists:

- `MCP_HTTP_ALLOWED_HOSTS`
- `MCP_HTTP_ALLOWED_ORIGINS`

## Credential-Sensitive Tools

Cloud connector creation tools accept user-provided cloud credentials and forward them to the VideoVector API. The MCP server does not persist them. Users should provide least-privilege credentials and rotate them according to their own cloud policy.
