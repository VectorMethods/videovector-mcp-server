# Installation

Use `npx` unless your runtime requires a global install.

```bash
npx -y @vectormethods/videovector-mcp-server
```

Claude Desktop and Cursor both use the stdio transport by default. Configure them with the examples in `examples/`.

The only required runtime value for local stdio clients is `VIDEOVECTOR_API_KEY`.
