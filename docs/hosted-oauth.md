# Hosted MCP with OAuth

Connect a remote MCP client to **https://api.vectormethods.com/mcp** using
Streamable HTTP and OAuth. The hosted service is ready for browser account
linking; you do not need to run the npm package or paste an API key.
This guide describes the hosted service. The runtime in this repository
(`package.json` version `2.1.1`) supports API-key stdio and self-hosted HTTP,
not hosted OAuth verification. See [self-hosting](self-hosting-http.md) for
that separate runtime.

## Connect an account

1. Add the MCP URL to your client's remote-server or custom-connector settings.
2. Choose OAuth and start connecting. If the client asks for registration mode,
   use automatic dynamic client registration rather than supplying a shared
   client secret.
3. Sign in to VideoVector in the browser tab opened by the client. Use the
   account whose media you want to access and verify its email if requested.
4. Keep that tab open while authorization returns to the client. The client
   stores its tokens and handles refresh. Ask it to list your indexes to
   confirm authenticated access.

New accounts start on Free. Linking itself does not require a paid plan or
profile form; tool calls still enforce the account's credits and entitlements.
Start linking from the MCP client, not by opening the login continuation URL
directly: the continuation requires a current, one-use authorization request.

OAuth is an account grant, including permitted tenant-level administration and
destructive operations. It is not a `read`, `write`, `search`, or `admin`
API-key scope. It does not grant platform administration, API-key management,
or access to Firebase-session-only and internal-service endpoints.

## Discovery and custom clients

| Setting | Value |
| --- | --- |
| MCP URL and OAuth resource | `https://api.vectormethods.com/mcp` |
| Protected-resource metadata | `https://api.vectormethods.com/.well-known/oauth-protected-resource/mcp` |
| Compatibility metadata alias | `https://api.vectormethods.com/.well-known/oauth-protected-resource` |
| Authorization-server discovery | Use the advertised `authorization_servers` issuer and its `/.well-known/oauth-authorization-server` document |
| Authorization flow | Authorization code with PKCE `S256` |
| OIDC identity scopes | `openid email profile offline_access` |
| Protected MCP request | `Authorization: Bearer <access_token>` |

Discover the current issuer and its authorization, token, registration, and
JWKS endpoints from metadata instead of pinning a provider hostname. Register
the callback URI used by the actual client. Use
`resource=https://api.vectormethods.com/mcp` on both the authorization request
and authorization-code token exchange. Request `offline_access` when the
client needs a refresh token, then use the advertised token endpoint's
`refresh_token` grant and retain any replacement refresh token it returns.
Tokens must retain the MCP resource audience through refresh.

OIDC scopes describe identity and refresh access. The protected-resource
document intentionally omits `scopes_supported`; published tools declare
`oauth2` with `scopes: []`. Do not invent custom VideoVector permission scopes.
Client-credentials or device-code flows are not substitutes for this account
linking flow, even when the provider supports them for other applications.

Send `Accept: application/json, text/event-stream` and JSON MCP POST requests.
The endpoint is stateless: do not persist or send `MCP-Session-Id`.
`GET /mcp` and `DELETE /mcp` return `405`. Protocol initialization and tool
discovery are available before sign-in; an anonymous protected tool call
returns a `401` challenge with `resource_metadata`. Discovering tools does not
authorize executing them.

## Available tools and existing API-key clients

OAuth tools support media upload, processing, search, results, and resource
management. Cloud-connector credential creation (`create_gcs_connector`,
`create_s3_connector`, `create_azure_connector`), webhook secret creation
(`create_webhook`), and bearer download URL creation (`get_export_download_url`)
are excluded from the OAuth tool list. Configure connectors and webhooks in
VideoVector, use existing resources from MCP, and open authenticated app links
for exports.

Existing API-key HTTP and local stdio clients remain supported. HTTP clients
send either `X-API-Key: <key>` or `Authorization: Bearer <key>`; do not combine
either header with another credential. Stdio uses `VIDEOVECTOR_API_KEY`.
API-key scopes continue to limit those integrations. The REST
`/api/v2/mcp/config` helper generates API-key configurations; it is not an
OAuth registration or token endpoint.

## Connection problems

- **Interrupted, missing, or expired linking request:** start a fresh connection
  from the MCP client. Reopening an old continuation URL or replaying its
  one-use completion is not supported.
- **Wrong VideoVector account:** sign out of VideoVector and restart linking
  from the client using the intended account.
- **Email verification required:** verify the VideoVector account's email and
  resume or restart the client connection.
- **Expired or invalid authorization:** let the client refresh its token. If
  refresh is rejected, reconnect. HTTP authentication failures and the tool
  result's `mcp/www_authenticate` metadata can prompt this flow.
- **Billing, quota, plan, or permission denial:** resolve the reported product
  requirement; these errors do not require a new OAuth grant.
- **Old tool list or missing result card:** refresh the client's discovered
  tools. Available MCP Apps rendering depends on the client.

Disconnect the integration in the client when it is no longer needed. Keep
access and refresh tokens in the client's credential store, not prompts,
workflow JSON, URLs, or repository configuration.
