# Release Process

Releases are orchestrated by `vectormethods-public-bot` from the private control
repository. Do not create or push release tags from a personal workstation,
personal GitHub account, or a manual public workflow dispatch.

## Normal Release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run local checks:

   ```bash
   npm ci
   npm run verify
   npm audit --omit=dev --audit-level=high
   npm pack --dry-run
   ```

3. Run the private `Public Repo Bot` workflow in `release` mode for this
   repository. The tag must match `videovector-mcp-vX.Y.Z` and target public
   `main`.
4. The bot verifies the public graph, creates or verifies the public tag,
   dispatches this repository's `Release` workflow, waits for npm, GHCR, and MCP
   Registry publish checks to pass, then creates the GitHub Release with scanned
   release text and generated notes disabled.

## First npm Publish

npm trusted publishing can only be configured after the package exists on the
registry. For the first publish only:

1. Use a generic company-owned npm account with 2FA enabled.
2. Add a short-lived `NPM_BOOTSTRAP_TOKEN` environment secret to the `npm`
   GitHub environment.
3. Run the private `Public Repo Bot` release for the first version.
4. Configure trusted publishing:

   ```bash
   npm install -g npm@^11.15.0
   npm trust github @vectormethods/videovector-mcp-server \
     --repo VectorMethods/videovector-mcp-server \
     --file release.yml \
     --env npm \
     --allow-publish
   ```

5. Delete the `NPM_BOOTSTRAP_TOKEN` secret and revoke the npm token.
6. In npm package settings, require 2FA and disallow token publishing.

After that bootstrap, releases must rely on OIDC trusted publishing only.
The workflow only uses `NPM_BOOTSTRAP_TOKEN` when the npm package does not
already exist. Future version publishes use npm trusted publishing with GitHub
OIDC.
