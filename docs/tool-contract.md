# Tool Contract

`artifacts/tool-contract.json` is the release artifact that describes the public MCP surface.

It includes:

- package name, version, and binary command
- server name and supported transports
- canonical and legacy environment variable names
- tool names, descriptions, input schemas, annotations, and categories

Regenerate it after tool changes:

```bash
npm run generate:contract
```

CI runs:

```bash
npm run check:contract
```

Private VectorMethods services should vendor this artifact during release instead of hand-maintaining duplicate MCP tool schemas.
