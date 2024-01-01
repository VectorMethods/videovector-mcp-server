# Changelog

## 2.1.0

- Documented browser OAuth account linking for the separately hosted MCP service,
  including client setup, discovery, PKCE, refresh, account permissions, and
  troubleshooting. The npm package continues to use API keys for stdio and
  self-hosted HTTP.
- Replaced stateful HTTP sessions with independent authenticated requests,
  bounded API-key validation, and safe idempotent retries.
- Aligned publication with the company release controller: immutable annotated
  tags, verified resumable draft bundles, reproducible npm artifacts,
  npm provenance, and npm-only MCP Registry metadata with explicit
  secret-marked credential inputs.
  The build uses pinned Node 24 and npm 11; the npm runtime requirement remains
  Node 18 or newer.
- Added the simplified `upload_media`, `define_prompt`, `process_media`, and
  `search_media` workflow tools backed by the additive `/api/v2/workflow`
  facade.
- Added `simple` and `full` tool profiles. `full` remains the compatibility
  default; `simple` exposes only the four workflow tools.
- Restricted local file upload to stdio, configured upload roots, regular
  files, and stable file identity across retries. The self-hosted package HTTP
  transport never advertises or executes `upload_media`.
- Aligned processing controls with deployed `content_aware` and `fixed`
  segmentation. Omitted processing, execution, and estimation settings preserve
  saved prompt and backend defaults; explicit boolean overrides remain intact.
- Accept the deployed export `result_scope` metadata (`all` or `matches`) in
  status and list responses while retaining authenticated download validation.
- Added cursor continuation for workflow search and automatic stable
  idempotency keys for all initial workflow mutations and searches.
- Refreshed the locked dependency graph within the existing declared ranges so
  runtime and release dependency audits remain clean.
- Expanded the generated contract, docs, examples, and tests to cover tool
  availability, transport restrictions, retry behavior, and all 52 tools.

## 2.0.2

- Derived the MCP protocol and outbound API client versions from package
  metadata so runtime identity cannot drift from the published release.
- Aligned `test_prompt_schema` with the backend's required `write` scope while
  retaining its non-destructive tool annotation.
- Clarified that first-party metadata export bearer URLs are short-lived,
  byte-bounded credentials, and direct large exports to the authenticated
  SDK/API streaming path or connector delivery instead of MCP context.
- Split export status from bearer minting: `get_export_status` is now a
  side-effect-free durable status read with authenticated download metadata,
  while the separate `get_export_download_url` capability tool invokes the
  explicit `/download-url` endpoint. Connector and unavailable exports retain
  `download_url: null`, while mint failures remain structured MCP errors.
- Validate export delivery responses before they cross the MCP boundary:
  status accepts only the canonical authenticated relative route, while minted
  capabilities require HTTPS, the configured API origin, the exact export
  path, and one bounded token query. Malformed JSON failures never include
  response or parser fragments.
- Hardened Streamable HTTP admission with canonical public-key validation,
  hash-only positive/negative caches and singleflight, bounded direct-peer and
  process candidate checks, and response-safe verification logging.
- Added atomic global/per-key session capacity, idle and absolute session
  expiry, and cleanup of abandoned transports without changing stdio auth.
- Limited automatic API retries to safe methods or writes carrying a stable
  idempotency key so unkeyed cost-bearing POSTs cannot be duplicated after an
  ambiguous provider or network result. Connector probes now carry a
  caller-supplied or generated stable key, allowing the client to retry the
  exact backend operation safely.
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
