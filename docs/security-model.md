# Security Model

The MCP server is a thin adapter over the VideoVector API. It does not
durably persist API keys, connector credentials, webhook secrets, or cloud
credentials.

## Stdio

In stdio mode, the MCP host starts the server process locally and passes `VIDEOVECTOR_API_KEY` through the process environment. The server forwards that key to the VideoVector API.

Local path shortcuts exist only in stdio mode. They canonicalize the source
and allowed roots with `realpath`, rejects files outside
`VIDEOVECTOR_UPLOAD_ROOTS` (the current working directory by default), requires
a supported regular media file, and rechecks its device, inode, and size after
opening without following a final symlink. Multipart bodies are streamed; a
retry reopens the file and reuses one backend idempotency key.

## Streamable HTTP

In HTTP mode, protected tool calls authenticate with exactly one credential: a
VideoVector API key or, when enabled, a WorkOS OAuth bearer token. OAuth
publication permits initialization and tool discovery before sign-in so clients
can discover the authorization requirement; this does not permit protected tool
execution. Mixed credentials are rejected. The transport is stateless: no session identifier,
credential, or server object is retained after the response closes. This
allows requests to move safely across instances and restarts.

HTTP tool listings expose native `files` inputs for `analyze` and `import_media`.
Local path fields are omitted and rejected at execution, so a remote caller
cannot cause the server to read a local filesystem path.

Native attachments use host-provided temporary HTTPS download capabilities. They do not require public sharing of the file. Sandbox and local paths are rejected by the hosted transport; the authorized stdio adapter uses a scoped upload grant internally, without forwarding account credentials. Missing media inputs return an error before admission. There is no embedded UI or upload picker.

Workflow summaries use reviewed public envelopes for every authentication
method. Raw media locations and storage paths are absent from model-visible
results; user-authored extracted metadata remains opaque data. Analysis JSON and
segment download links are intentional first-party, one-hour bearer capabilities.
Segment delivery validates current access and exact snapshot membership before
redirecting to the canonical generation-pinned storage download. Agents follow
that redirect without forwarding account credentials.


## Credential-sensitive options

Direct API-key/stdio integrations may supply cloud source configuration or a task callback signing secret to `analyze`/`import_media`. The MCP server forwards these only to the configured first-party API and does not persist or log them. Callbacks are terminal-only and scoped to the submitted task. Use least-privilege credentials and protect the caller's signing secret.

OAuth exposes the same six names while omitting cloud source and webhook arguments. Runtime schema validation rejects excluded options before backend dispatch. Analysis/search downloads remain authorized one-hour result capabilities. They are scoped to a captured snapshot and separate from private account credentials and upload grants. Generic download clients fetch them without forwarding OAuth headers. Export administration remains outside MCP.

See [hosted OAuth](hosted-oauth.md#available-tools-and-existing-api-key-clients).
