# Self-Hosted Streamable HTTP

HTTP mode exposes the MCP server over Streamable HTTP for private network or self-hosted deployments.

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
rejects development-key formats before normal API use.

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
