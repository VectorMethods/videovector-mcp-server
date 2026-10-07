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
   dispatches this repository's `Release` workflow on that exact annotated tag
   with both its tag-object SHA and peeled commit SHA, waits for npm, GHCR, and
   MCP Registry publish checks to pass, then creates the GitHub Release with
   scanned release text and generated notes disabled.

## Immutable Release Bundle

The build job creates one `mcp-release-bundle` without registry credentials.
It has `contents: write` because recovery reads GitHub draft assets, which
require push access. Checkout credentials are never persisted. The separate
staging job re-verifies the exact transport and reconciles the three assets on
the bot-owned draft GitHub Release. The bundle contains:

- the exact npm tarball;
- a deterministic OCI index containing exactly `linux/amd64` and
  `linux/arm64`;
- the exact MCP Registry `server.json`;
- `registry-metadata.json`; and
- `release-manifest.json`.

`release-manifest.json` separately binds the annotated tag-object SHA, peeled
tag commit, source commit, exact tag/version, commit-derived
`SOURCE_DATE_EPOCH`, release-body SHA-256, every artifact byte hash, the OCI
index digest, both platform manifest/config digests, canonical source
repository, registry-metadata hash, and exact tool versions. The complete
bundle is built independently twice and must be byte-for-byte identical. Only
the first verified bundle is retained and published. Every publication job
downloads that bundle; it never runs `npm pack` or `docker build`.

The guard requires `expected_tag_object_sha` and `expected_target_sha` to be
full lowercase SHAs, rejects lightweight tags, and requires the tag object,
peeled tag commit, checkout, and workflow event to match the bot request. It
intentionally does not compare the release tag to moving public `main`: an
interrupted publication remains resumable from the immutable tag after newer
changes reach `main`.

Before a write, the workflow classifies the target version as either missing or
an exact replay:

- npm requires a non-deprecated version with identical tarball bytes, package
  identity, executable map, and engine metadata;
- GHCR requires the exact OCI index, both platform manifests/configs, and
  provenance labels; and
- MCP Registry queries with `include_deleted=true` and requires the exact
  publication-owned metadata in the `active` lifecycle state.

The three registries use one publication state machine. It checks authoritative
state before any mutation, dispatches a mutation at most once, and then settles
the exact read-after-write state. A timeout after a committed write is therefore
an exact replay, never a second publish. npm initially publishes under a
version-derived temporary tag, monotonically advances `latest` (or `next` for a
prerelease), confirms the tag readback, and removes the temporary tag. Older
resume runs never regress a newer dist-tag.

Release verification also requires the OCI config to default to stdio and both
Registry package entries to carry the same canonical, secret-marked
`VIDEOVECTOR_API_KEY` input. The Registry metadata describes these distributable
stdio packages. The
separately deployed hosted OAuth service is documented in
[Hosted OAuth](./hosted-oauth.md); it is not added to this package release metadata.

An existing mismatch, deprecated/deleted version, or unavailable registry fails
closed. GHCR absence is accepted only when Skopeo returns a known missing
manifest response and a bounded, complete GitHub Packages census also confirms
the tag is absent. A failed publication can be resumed without rebuilding. A
resumed workflow downloads the exact digest-bound draft asset, but still reruns
the complete source suite, dependency audit, independent controller-grade
semantic verifier, and npm/OCI runtime smokes. Exact targets are reconciled and
only confirmed-missing targets consume the tested bundle. The MCP `server.json`
names the immutable OCI index digest rather than the mutable version tag. The
normal GHCR publisher requires the exact organization package to already exist
as public before registry authentication; the separately approved one-time
bootstrap below is the only creation exception. Every path proves anonymous
readability of the exact multi-platform digest.

The workflow is serialized across the entire package, not per release tag.
Bundle verification runs before registry authentication, registry mutation,
or MCP publisher installation. The checksum-pinned npm toolchain is installed
before locked dependencies in every job, but cannot authenticate until the
publisher job receives its GitHub OIDC identity. Build and manifest tooling
remain pinned to npm 11.15.0; after bundle verification, the npm publisher
installs checksum-pinned npm 11.21.0 for OIDC publication and dist-tag updates.
npm publication fails if any static token surface is present. npm and MCP publisher downloads are
checksum-pinned, while QEMU/binfmt, Skopeo, BuildKit, Buildx, Node, and every
GitHub Action are immutable-version pinned.

The private bot must verify the same tag-object SHA, peeled commit SHA, and
release-body hash, attach the two manifest files to the GitHub Release, and
treat an existing release as successful only when its tag, body, and attached
manifest bytes match. Only build/recovery and draft-staging receive
`contents: write`; the guard and
registry publishers retain read-only repository access. Publisher materialization
uses the downloaded Actions artifact and does not read private draft assets.
The npm and OCI stdio smokes compare their server version and complete tool names
with the generated contract, including the stdio-only upload tool.

## One-time GHCR Public-package Bootstrap

Normal releases never create or change package visibility. They continue to
require `ghcr.io/vectormethods/videovector-mcp-server` to exist under the exact
VectorMethods organization identity with public visibility before registry
authentication. This fail-closed rule prevents an ordinary release from
silently publishing a private or mis-owned image.

The first publication has one explicit convergence path. Configure the
`ghcr-public-bootstrap` GitHub environment with:

- required-reviewer approval and administrator bypass disabled;
- a deployment tag allowlist limited to `videovector-mcp-v*`; and
- no environment secrets.

After the protected control-plane bot has verified the exact annotated tag,
source SHA, release bundle, and provenance, an owner may approve that exact
source/digest operation. The bot then dispatches the normal release workflow
with the explicit `bootstrap_ghcr_public` input set to `true`. The guarded
bundle supplies the immutable lowercase `sha256:` OCI index digest. The
default `false` input is the normal release mode and does not enter the
protected bootstrap environment.

The bootstrap job independently materializes and verifies the immutable bundle
before registry authentication. Its token is the ephemeral workflow token
scoped only to `contents: read` and `packages: write`; it has no deployment,
repository-write, or npm credential. Before the push, it proves through the
GitHub API that the publishing repository is exactly the public
`VectorMethods/videovector-mcp-server` repository. GitHub links a package
created by that workflow token to the publishing repository and applies the
public repository's inherited visibility. The job reconciles the exact
multi-platform digest once, requires that exact inherited public package
identity, and then reads the complete OCI index anonymously and re-verifies
every digest and label. A push response may be lost: the mutation is dispatched
at most once and completion is settled from authoritative readback. Re-running
the same approved operation is therefore an exact replay. A pre-existing
private package is never modified or overwritten by this path. A different
digest, owner, package, source repository, media shape, tag state, or
non-public visibility fails closed.

Once the package is public, leave `bootstrap_ghcr_public` set to `false`.
The normal GHCR publisher immediately follows the bootstrap job and applies its
unchanged public-package preflight, so the exceptional path cannot weaken later
releases.

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
