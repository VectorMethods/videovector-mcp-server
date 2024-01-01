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
- `GET /mcp`
- `DELETE /mcp`

Every `/mcp` request must include `Authorization: Bearer <key>` or `X-API-Key:
<key>`. Both HTTP and stdio modes accept canonical production API keys only:
`sk_live_` followed by exactly 48 lowercase hexadecimal characters. The server
rejects development-key formats before normal API use.

Recommended hardening:

- Set `MCP_HTTP_ALLOWED_HOSTS` for deployed services.
- Set `MCP_HTTP_ALLOWED_ORIGINS` before allowing browser clients.
- Keep the default global and per-key session limits, idle/absolute expiry, and
  API-key candidate admission guards enabled. Their environment variables are
  documented in the README and `.env.example`.
- Candidate limits use the direct socket peer and intentionally ignore
  caller-controlled forwarding headers. Put a trusted edge rate limiter in
  front of a broadly shared proxy deployment if client-specific limits are
  required.
- Keep service deployment secrets, service accounts, and cloud project IDs outside this public repo.
- Do not publish a hosted remote MCP endpoint until OAuth and MCP protected-resource metadata are implemented for that deployment.
