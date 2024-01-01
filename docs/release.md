# Release Process

Releases are automation-driven from the public repository. Do not create or
push release tags from a personal workstation or personal GitHub account.

## Normal Release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run local checks:

   ```bash
   npm ci
   npm run verify
   npm audit --omit=dev --audit-level=high
   npm pack --dry-run
   ```

3. Dispatch the `Release` workflow from GitHub Actions with the exact version,
   for example `2.0.1`.
4. The workflow verifies package metadata, builds and tests the package,
   publishes to npm through trusted publishing, then creates the
   `videovector-mcp-vX.Y.Z` GitHub release tag.

## First npm Publish

npm trusted publishing can only be configured after the package exists on the
registry. For the first publish only:

1. Use a generic company-owned npm account with 2FA enabled.
2. Add a short-lived `NPM_BOOTSTRAP_TOKEN` environment secret to the `npm`
   GitHub environment.
3. Run the `Release` workflow for the first version.
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
