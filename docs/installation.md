# Installation

For a remote MCP client, connect to `https://api.vectormethods.com/mcp` with
browser OAuth. No local installation or API key is needed. Follow
[hosted OAuth setup](hosted-oauth.md) for account linking and client configuration.

For local stdio, use `npx` unless your runtime requires a global install.

```bash
npx -y @vectormethods/videovector-mcp-server
```

Claude Desktop and Cursor can run this local stdio server. Use the local
configuration examples in [`examples/`](../examples/) when choosing this path;
their remote OAuth configurations are described in the [README](../README.md#connect-to-hosted-videovector).

The only required runtime value for local stdio clients is `VIDEOVECTOR_API_KEY`.

For the four-tool workflow surface, also set:

```bash
VIDEOVECTOR_TOOL_PROFILE=simple
VIDEOVECTOR_UPLOAD_ROOTS=/absolute/path/to/media
```

`VIDEOVECTOR_UPLOAD_ROOTS` is optional and defaults to the server process's
working directory. Use an explicit narrow root when enabling `upload_media`.
