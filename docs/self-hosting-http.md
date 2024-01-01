# Self-Hosted Streamable HTTP

HTTP mode exposes the MCP server over Streamable HTTP for private network or self-hosted deployments.

To use VectorMethods' existing service instead, connect to
`https://api.vectormethods.com/mcp` with OAuth as described in
[hosted setup](hosted-oauth.md). The environment variables below are for
operators running their own server.

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

Protected `/mcp` tool calls must include exactly one credential: `Authorization:
Bearer <key>` or `X-API-Key: <key>`, or an OAuth bearer token when enabled.
API-key authentication in both HTTP and stdio modes accepts canonical production API keys only:
`sk_live_` followed by exactly 48 lowercase hexadecimal characters. The server
rejects development-key formats before normal API use. Combining the two
headers is an ambiguous request and is rejected.

Hosted deployments may additionally accept WorkOS OAuth bearer tokens:

```bash
MCP_TRANSPORT_MODE=http \
MCP_OAUTH_ENABLED=true \
MCP_OAUTH_METADATA_ENABLED=false \
MCP_OAUTH_ISSUER=https://your-environment.authkit.app \
MCP_OAUTH_JWKS_URL=https://your-environment.authkit.app/oauth2/jwks \
MCP_OAUTH_RESOURCE=https://api.example.com/mcp \
MCP_OAUTH_CLOCK_SKEW_SECONDS=60 \
node dist/index.js
```

The issuer must be a canonical HTTPS origin, the JWKS URL must be its exact
`/oauth2/jwks` endpoint without a query or fragment, and the resource must be a
canonical HTTPS URL with a path and no query or fragment.
The API also verifies the forwarded bearer token. OAuth configuration must
match that backend's supported WorkOS issuer, resource audience, and signed
Firebase identity claims. Setting Node environment variables alone does not
add a different OAuth provider to the VectorMethods-hosted API.
OAuth is disabled and unadvertised by default. Deploy verification first, then
serve protected-resource metadata from the public resource origin at
`/.well-known/oauth-protected-resource/mcp`, and enable
`MCP_OAUTH_METADATA_ENABLED` last. The Node service intentionally does not
serve authorization-server endpoints, call UserInfo, or introspect tokens.
When metadata is enabled, initialization and tool discovery can run without a
credential so clients can discover OAuth; protected tool calls still require
authentication. Clients must accept both `application/json` and
`text/event-stream` and omit `MCP-Session-Id`.

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
- Do not publish a hosted remote MCP endpoint until OAuth verification and MCP protected-resource metadata are enabled for that deployment.

For the VectorMethods-hosted stage service, the direct Cloud Run origin is
not a public ingress path. Cloud Run uses
`internal-and-cloud-load-balancing` ingress and an external HTTPS load
balancer with a serverless NEG. The service may remain unauthenticated at
Cloud Run IAM because protected MCP tool calls authenticate an API key or OAuth token, but unrestricted
Cloud Run ingress is forbidden.

The hosted load-balancer backend is attached to a Cloud Armor source-IP
throttle (600 requests per minute by default). It is a coarse capacity
boundary only; per-key verification bounds, backend fingerprint controls, and
global service capacity remain authoritative. Operators may tune
`MCP_CLOUD_ARMOR_RATE_LIMIT_RPM`, but must keep the policy attached and verify
that the public Internet cannot reach the `run.app` origin.
