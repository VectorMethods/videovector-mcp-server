## Summary

Describe the change and the MCP surface it affects.

## Checks

- [ ] `npm run verify`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npm pack --dry-run`
- [ ] Tool contract updated with `npm run generate:contract` when tool schemas changed
- [ ] README/docs/examples updated when install, config, transport, or tool behavior changed
- [ ] No secrets, private project IDs, deployment credentials, or internal backend-only code added

## Contract Impact

State whether this changes tool names, descriptions, schemas, annotations, transport behavior, or environment variables.

