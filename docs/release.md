# Release Process

Releases are orchestrated by `vectormethods-public-bot` from the private control
repository. Do not create or push release tags from a personal workstation,
personal GitHub account, or a manual public workflow dispatch.

## Normal Release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run local checks:

   ```bash
   npm ci --ignore-scripts
   npm run verify
   npm audit --audit-level=high
   npm pack --dry-run
   ```

3. Run the private `Public Repo Bot` workflow in `release` mode for this
   repository. The tag must match `videovector-mcp-vX.Y.Z` and target public
   `main`.
4. The bot verifies the public graph, creates or verifies the public tag,
   dispatches this repository's `Release` workflow on that exact tag with its
   peeled commit SHA, waits for npm, GHCR, and MCP Registry publish checks to
   pass, then creates the GitHub Release with scanned release text and generated
   notes disabled.

## Immutable Release Bundle

The workflow builds one `mcp-release-bundle` before it receives any registry
write permission. The bundle contains:

- the exact npm tarball;
- a deterministic, single-platform OCI archive;
- the exact MCP Registry `server.json`;
- `registry-metadata.json`; and
- `release-manifest.json`.

`release-manifest.json` binds the source and tag SHA, commit-derived
`SOURCE_DATE_EPOCH`, release-body SHA-256, every artifact byte hash, the OCI
manifest digest, canonical source repository, registry-metadata hash, and the exact tool versions. The
npm tarball and OCI archive are each built once. Every publication job downloads
that bundle; it never runs `npm pack` or `docker build`.

The guard requires the bot-provided `expected_target_sha` to be a full
lowercase commit SHA and requires the peeled tag, checked-out commit, and
workflow event SHA to equal it. It intentionally does not compare the release
tag to moving public `main`: an interrupted publication remains resumable from
the immutable tag after newer changes reach `main`.

Before a write, the workflow classifies the target version as either missing or
an exact replay:

- npm requires identical tarball bytes, package identity, executable map, and
  engine metadata;
- GHCR requires the exact OCI manifest digest and provenance labels; and
- MCP Registry requires the exact publication-owned server and package
  metadata.

An existing mismatch or an unavailable registry fails closed. A failed
publication can be resumed without rebuilding: exact targets are skipped and
only missing targets consume the already tested bundle. The GHCR package must
be configured as public before its first release; every run proves anonymous
readability and rechecks the exact digest after publication.

The private bot must verify the same tag SHA and release-body hash, attach the
two manifest files to the GitHub Release, and treat an existing release as
successful only when its tag, body, and attached manifest bytes match. The
public workflow deliberately has read-only GitHub Release permission.

## First npm Publish

npm trusted publishing can only be configured after the package exists on the
registry. For the first publish only:

1. Use a generic company-owned npm account with 2FA enabled.
2. Add a short-lived `NPM_BOOTSTRAP_TOKEN` environment secret to the `npm`
   GitHub environment.
3. Run the private `Public Repo Bot` release for the first version.
4. Configure trusted publishing:

   ```bash
   npm install -g npm@11.15.0
   npm trust github @vectormethods/videovector-mcp-server \
     --repo VectorMethods/videovector-mcp-server \
     --file release.yml \
     --env npm \
     --allow-publish
   ```

5. Delete the `NPM_BOOTSTRAP_TOKEN` secret and revoke the npm token.
6. In npm package settings, require 2FA and disallow token publishing.

After that bootstrap, releases must rely on OIDC trusted publishing only.
Future version publishes use npm trusted publishing with GitHub OIDC.
