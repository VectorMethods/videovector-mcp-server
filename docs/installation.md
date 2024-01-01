# Installation

Use `npx` unless your runtime requires a global install.

```bash
npx -y @vectormethods/videovector-mcp-server
```

Claude Desktop and Cursor both use the stdio transport by default. Configure them with the examples in `examples/`.

The only required runtime value for local stdio clients is `VIDEOVECTOR_API_KEY`.

For the four-tool workflow surface, also set:

```bash
VIDEOVECTOR_TOOL_PROFILE=simple
VIDEOVECTOR_UPLOAD_ROOTS=/absolute/path/to/media
```

`VIDEOVECTOR_UPLOAD_ROOTS` is optional and defaults to the server process's
working directory. Use an explicit narrow root when enabling `upload_media`.
