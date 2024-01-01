# Changelog

## 2.0.2

- Derived the MCP protocol and outbound API client versions from package
  metadata so runtime identity cannot drift from the published release.
- Aligned `test_prompt_schema` with the backend's required `write` scope while
  retaining its non-destructive tool annotation.
- Clarified that first-party metadata export bearer URLs are short-lived,
  byte-bounded credentials, and direct large exports to the authenticated
  SDK/API streaming path or connector delivery instead of MCP context.
- Hardened Streamable HTTP admission with canonical public-key validation,
  hash-only positive/negative caches and singleflight, bounded direct-peer and
  process candidate checks, and response-safe verification logging.
- Added atomic global/per-key session capacity, idle and absolute session
  expiry, and cleanup of abandoned transports without changing stdio auth.
- Limited automatic API retries to safe methods or writes carrying a stable
  idempotency key so search, LLM, connector-test, and other cost-bearing POSTs
  cannot be duplicated after an ambiguous provider or network result.
- Aligned stdio key validation and dual-header authentication precedence with
  the hardened API, and added actionable quota/LLM guard suggestions without
  dropping structured error details.

All notable changes to the VideoVector MCP server are documented here.

This project uses release tags and machine-readable release artifacts under [`artifacts/`](./artifacts). The vendored tool contract in downstream private services should match a tagged release from this repository.

## 2.0.0

- Initial public repository seed for `@vectormethods/videovector-mcp-server`.
- Renamed the MCP package, binary, server identity, and environment variables to VideoVector/VectorMethods names.
- Added stdio-first MCP server support with generic self-hostable Streamable HTTP mode.
- Added machine-readable tool contract and release metadata artifacts.
- Added examples and setup documentation for Claude Desktop, Cursor, custom stdio clients, and HTTP self-hosting.
