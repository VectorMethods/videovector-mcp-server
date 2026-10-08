# Self-Hosted Streamable HTTP

HTTP mode exposes the MCP server over Streamable HTTP for private network or self-hosted deployments.

To use VectorMethods' existing OAuth service instead, connect to
`https://api.vectormethods.com/mcp` as described in
[hosted setup](hosted-oauth.md).

The runtime in this repository (`package.json` version `2.1.2`) uses API-key
authentication for self-hosted HTTP. It does not implement the hosted
service's OAuth verifier or protected-resource discovery. The configuration below describes this package;
adding `MCP_OAUTH_*` environment variables does not add OAuth support.

```bash
npm run build
MCP_TRANSPORT_MODE=http \
VIDEOVECTOR_BASE_URL=https://api.vectormethods.com/api/v2 \
node dist/index.js
```

Endpoints:

- `GET /health`
- `POST /mcp`

HTTP mode is stateless: every POST creates and closes its own MCP
server/transport context. Follow-up requests can be routed to a different
instance without affinity. `GET /mcp` and `DELETE /mcp` intentionally return a
protocol-shaped `405`.

Every `/mcp` request must include `Authorization: Bearer <key>` or `X-API-Key:
<key>`. Both HTTP and stdio modes accept canonical production API keys only:
`sk_live_` followed by exactly 48 lowercase hexadecimal characters. The server
rejects development-key formats before normal API use. Send one authentication
header. This package gives `X-API-Key` precedence if both are supplied; the
hosted service rejects mixed credentials.

Clients must send `Accept: application/json, text/event-stream` and omit
`MCP-Session-Id`. In this package, every MCP POST requires an API key,
including initialization and tool discovery. The hosted OAuth service allows
those discovery requests before sign-in and protects actual tool calls.

Any future self-hosted OAuth integration must also match the backend's
supported issuer, resource audience, and signed identity claims. Changing a
Node server's authentication settings alone does not add another OAuth
provider to the VectorMethods-hosted API.

Recommended hardening:

- Set `MCP_HTTP_ALLOWED_HOSTS` for deployed services.
- Set `MCP_HTTP_ALLOWED_ORIGINS` before allowing browser clients.
- Keep the default bounded API-key verifier. It singleflights checks by a
  process-secret credential fingerprint and bounds backend verification
  concurrency without imposing shared-IP or cross-tenant candidate limits.
- Put a trusted edge rate limiter in front of a public deployment. The
  application verifier protects backend capacity but is not an IP abuse
  control.
- Keep `MCP_HTTP_SHUTDOWN_DRAIN_SECONDS` below the platform termination grace
  period so in-flight requests settle before the instance exits.
- Keep service deployment secrets, service accounts, and cloud project IDs outside this public repo.
- Do not publish a hosted remote MCP endpoint until OAuth and MCP protected-resource metadata are implemented for that deployment.
