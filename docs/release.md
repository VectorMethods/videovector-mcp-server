# Release Process

Releases are orchestrated by `vectormethods-public-bot` from the private control
repository. Do not create or push release tags from a personal workstation,
personal GitHub account, or a manual public workflow dispatch.

The active release lane publishes the npm package and its MCP Registry listing.
The Registry entry describes a single npm stdio package. Containers are not
release artifacts or publication targets. Docker remains available for local
self-hosting and independent CI smoke checks.

## Normal Release

1. Update `package.json`, `package-lock.json`, `server.json`, and `CHANGELOG.md`.
2. Run the complete source checks:

   ```bash
   npm ci --ignore-scripts
   npm run verify
   npm audit --audit-level=high
   npm pack --dry-run
   ```

3. Run the private `Public Repo Bot` workflow in `release` mode. The tag must
   match `videovector-mcp-vX.Y.Z` and target public `main`.
4. The bot verifies the public graph and owner-approved release request, creates
   or verifies the exact annotated tag, and creates the matching draft release.
   It dispatches this repository's `Release` workflow with the tag-object SHA,
   peeled commit SHA, release-body digest, operation nonce, and draft ID.
5. The public workflow stages and attests the verified bundle, publishes npm,
   then publishes the exact MCP Registry metadata. The private controller
   verifies both registries, the signed assets, and the exact tag and release
   text before finalizing the immutable GitHub Release. Generated notes remain
   disabled.

## Immutable Release Bundle

The build job creates the bundle twice without registry credentials; both builds
must be byte-for-byte identical. It contains exactly these four files:

- `npm/vectormethods-videovector-mcp-server-VERSION.tgz`;
- `mcp/server.json`;
- `registry-metadata.json`; and
- `release-manifest.json`.

The schema 2.0.0 manifest binds the annotated tag object, peeled tag commit,
source commit, exact version and source repository, commit-derived
`SOURCE_DATE_EPOCH`, release-body SHA-256, artifact paths/sizes/hashes, registry
metadata hash, and the exact Node 24.14.0/npm 11.15.0 build toolchain.
`image_digest` must be null. The artifact kinds are exactly `npm-tarball` and
`mcp-registry-metadata`; extra container descriptors or registry fields are
rejected. The independent Python verifier streams the npm archive without
executing its contents and enforces the same closed inventory and identities.

The standalone `server.json` must match the npm package's embedded metadata.
It contains exactly one npm package with its version, stdio transport, and four
canonical environment settings, including the required secret-marked
`VIDEOVECTOR_API_KEY`. The separately deployed hosted OAuth service is documented
in [Hosted OAuth](./hosted-oauth.md); this package listing describes the npm
runtime.

The guard rejects lightweight tags and requires the annotated object, peeled
commit, checkout, workflow event, and request to agree. It does not compare the
immutable tag with moving public `main`, so an interrupted release can resume
after later commits reach `main`.

## Staging, Publication, and Recovery

The build job has `contents: write` because recovery reads private draft assets.
The separate staging job re-verifies the archive and reconciles exactly three
bot-owned GitHub Release assets: `release-bundle.zip`, `release-manifest.json`,
and `registry-metadata.json`. Their exact digests receive GitHub provenance
attestations. Checkout credentials are never persisted. Publishers materialize
the local Actions artifact and retain read-only repository access.

Before each registry mutation, the publisher checks authoritative state:

- npm must be absent or an exact non-deprecated version with identical tarball
  bytes, package identity, executable map, and engine metadata.
- MCP Registry reads include deleted versions and require the exact
  publication-owned metadata in the `active` lifecycle state.

Conflicting, deprecated, deleted, or unavailable initial state fails closed.
Each mutation occurs at most once, followed by bounded read-only settlement.
A lost response after a committed write is reconciled from the authoritative
state. npm first uses a version-specific temporary dist-tag, monotonically
advances `latest` or prerelease `next`, confirms readback, and removes the
temporary tag. Resuming an older version cannot regress a newer dist-tag.

The package-wide workflow lock serializes releases. MCP Registry publication
runs only after npm succeeds. Every publisher verifies the exact bundle before
authentication or publisher installation. A resumed workflow retrieves the exact
draft release ID, asset ID, and SHA-256, then reruns source verification, the
dependency audit, independent semantic checks, and the npm stdio smoke. The
smoke compares the published server version and full tool list against the
committed contract, including the stdio-only upload tool.

Node, npm, the MCP publisher, and GitHub Actions are pinned. Build and manifest
tooling use npm 11.15.0. After bundle verification, the npm publisher installs
checksum-pinned npm 11.21.0 for GitHub OIDC publication with provenance and
OIDC dist-tag updates. Static npm tokens are rejected. The MCP publisher uses
GitHub OIDC in an isolated temporary home that is removed after publication.

## npm Trusted Publisher Prerequisite

The release workflow has no static-token fallback. Before the first
bot-dispatched release, a company administrator must create or transfer the
package and configure trusted publishing through a separately reviewed,
out-of-band npm administration procedure:

   ```bash
   bash scripts/install_pinned_npm.sh publisher
   npm trust github @vectormethods/videovector-mcp-server \
     --repo VectorMethods/videovector-mcp-server \
     --file release.yml \
     --env npm \
     --allow-publish
   ```

Also enable writing distribution tags for this exact trusted publisher in npm
package settings, so publication can advance `latest` and remove its temporary
tag through OIDC. Require 2FA and disallow token publishing. If the
exact trusted-publisher relationship is absent, the release must fail closed;
the release workflow must never be used to bootstrap it.

### npm registry visibility

After one publication or dist-tag mutation, the publisher reconciles read-only
registry observations for up to ten minutes. Missing versions, stale packuments,
and transient read failures during that window never trigger a second mutation.
Conflicting package bytes fail immediately. Version publication, monotonic target
tag promotion, and temporary tag cleanup each have an independent bounded window;
the npm job allows forty minutes for setup and all three phases. A later recovery
reuses the verified draft bundle and skips any registry state already exact.


Before publication, the checksum-pinned npm publisher is exercised offline with
its actual provenance implementation. The publisher retains the GitHub repository
and owner IDs and hosted-runner identity along with the exact workflow, source,
tag, and run. Signing and network calls are replaced only for this contract check;
the subsequent publication uses GitHub OIDC and real npm provenance. Publication
failures retain bounded, redacted cause details during authoritative reconciliation.
