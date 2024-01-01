# Tool Contract

`artifacts/tool-contract.json` is the release artifact that describes the public MCP surface.

It includes:

- package name, version, and binary command
- server name and supported transports
- canonical environment variable names
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

## Export status and capability example

Status polling is side-effect free. A completed direct export exposes only its
authenticated API endpoint:

```json
{
  "export_id": "exp_example",
  "status": "completed",
  "destination_type": "download",
  "destination_connector_id": null,
  "download_url": "/api/v2/exports/exp_example/download"
}
```

Only the separate `get_export_download_url` tool invokes the bearer-capability
mint endpoint. Its response has exactly five fields, and `download_url` remains
`null` whenever the export is not directly downloadable:

```json
{
  "export_id": "exp_example",
  "status": "completed",
  "destination_type": "download",
  "destination_connector_id": null,
  "download_url": "<short-lived bounded bearer URL>"
}
```
