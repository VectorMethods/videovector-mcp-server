# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not store API keys, connector credentials, webhook secrets, or cloud credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

## Streamable HTTP

In HTTP mode, every MCP request must authenticate with a VideoVector API key. Sessions are bound to a hash of the API key used at initialization, so a session cannot be reused with another key.

HTTP mode has optional host and origin allowlists:

- `MCP_HTTP_ALLOWED_HOSTS`
- `MCP_HTTP_ALLOWED_ORIGINS`

## Credential-Sensitive Tools

Cloud connector creation tools accept user-provided cloud credentials and forward them to the VideoVector API. The MCP server does not persist them. Users should provide least-privilege credentials and rotate them according to their own cloud policy.
