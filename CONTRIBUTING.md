# Contributing

Thanks for improving the VideoVector MCP server.

## Local Checks

```bash
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

## Tool Contract Changes

When adding or changing tools:

1. Update tool definitions and handlers.
2. Add focused tests for request validation and response formatting.
3. Run `npm run generate:contract`.
4. Include the generated `artifacts/tool-contract.json` changes in the same pull request.

## Public-Safe Content

Do not commit:

- `.env` files
- API keys
- cloud provider credentials
- webhook secrets
- real customer data
- private VectorMethods deployment config

Use placeholders such as `<your-videovector-api-key>` in documentation and examples.
