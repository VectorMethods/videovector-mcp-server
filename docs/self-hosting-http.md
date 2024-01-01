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

Every `/mcp` request must include `Authorization: Bearer <key>` or `X-API-Key: <key>`.

Recommended hardening:

- Set `MCP_HTTP_ALLOWED_HOSTS` for deployed services.
- Set `MCP_HTTP_ALLOWED_ORIGINS` before allowing browser clients.
- Keep service deployment secrets, service accounts, and cloud project IDs outside this public repo.
- Do not publish a hosted remote MCP endpoint until OAuth and MCP protected-resource metadata are implemented for that deployment.
