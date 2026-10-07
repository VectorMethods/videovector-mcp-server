#!/usr/bin/env bash
set -euo pipefail

required_environment=(
  EXPECTED_TARGET_SHA
  EXPECTED_TAG_OBJECT_SHA
  GITHUB_ACTOR
  GITHUB_OUTPUT
  GITHUB_REF
  GITHUB_REPOSITORY
  GITHUB_SHA
  DRAFT_RELEASE_ID
  OPERATION_NONCE
  RELEASE_BODY_SHA256
  RELEASE_TAG
  RELEASE_TAG_PREFIX
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
done

if [[ "$GITHUB_ACTOR" != "vectormethods-public-bot[bot]" &&
  "$GITHUB_ACTOR" != "vectormethods-public-bot" ]]; then
  echo "Release workflow may only be dispatched by vectormethods-public-bot." >&2
  exit 1
fi
if [[ ! "$EXPECTED_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected_target_sha must be a full lowercase 40-character Git commit SHA." >&2
  exit 1
fi
if [[ ! "$EXPECTED_TAG_OBJECT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected_tag_object_sha must be a full lowercase 40-character Git tag object SHA." >&2
  exit 1
fi
if [[ ! "$RELEASE_BODY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "release_body_sha256 must be a lowercase SHA-256 digest." >&2
  exit 1
fi
if [[ ! "$OPERATION_NONCE" =~ ^[0-9a-f]{64}$ ]]; then
  echo "operation_nonce must be a lowercase SHA-256 digest." >&2
  exit 1
fi
if [[ ! "$DRAFT_RELEASE_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "draft_release_id must be a positive base-10 integer." >&2
  exit 1
fi
if [[ "${BOOTSTRAP_GHCR_PUBLIC:-false}" != "true" &&
  "${BOOTSTRAP_GHCR_PUBLIC:-false}" != "false" ]]; then
  echo "bootstrap_ghcr_public must be an exact boolean." >&2
  exit 1
fi
bundle_source_count=0
for value in \
  "${BUNDLE_SOURCE_RELEASE_ID:-}" \
  "${BUNDLE_SOURCE_ASSET_ID:-}" \
  "${BUNDLE_SOURCE_SHA256:-}"; do
  if [[ -n "$value" ]]; then
    bundle_source_count=$((bundle_source_count + 1))
  fi
done
if [[ "$bundle_source_count" != 0 && "$bundle_source_count" != 3 ]]; then
  echo "bundle source release id, asset id, and SHA-256 must be supplied together." >&2
  exit 1
fi
if [[ "$bundle_source_count" == 3 ]]; then
  if [[ ! "$BUNDLE_SOURCE_RELEASE_ID" =~ ^[1-9][0-9]*$ ||
    ! "$BUNDLE_SOURCE_ASSET_ID" =~ ^[1-9][0-9]*$ ||
    ! "$BUNDLE_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "bundle source identity is malformed." >&2
    exit 1
  fi
  resume=true
else
  resume=false
fi
if [[ "$RELEASE_TAG" != "$RELEASE_TAG_PREFIX"* ]]; then
  echo "Release tag does not have the required repository prefix." >&2
  exit 1
fi
version="${RELEASE_TAG#"$RELEASE_TAG_PREFIX"}"
if ! VERSION="$version" node <<'NODE'
const version = process.env.VERSION;
const match =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
if (
  !match
  || (match[4] ?? '').split('.').some(
    (identifier) => /^[0-9]+$/.test(identifier)
      && identifier.length > 1
      && identifier.startsWith('0')
  )
) {
  process.exit(1);
}
NODE
then
  echo "Release tag does not contain a valid release version." >&2
  exit 1
fi

tag_ref="refs/tags/${RELEASE_TAG}"
if [[ "$GITHUB_REF" != "$tag_ref" ]]; then
  echo "Release workflow must be dispatched on the exact release tag ref." >&2
  exit 1
fi
if ! git show-ref --verify --quiet "$tag_ref"; then
  echo "Release tag ref is unavailable in the checked-out repository." >&2
  exit 1
fi

tag_object_sha="$(git rev-parse --verify "$tag_ref")"
tag_object_type="$(git cat-file -t "$tag_object_sha")"
if [[ "$tag_object_type" != "tag" ]]; then
  echo "Release ref must be an annotated tag object." >&2
  exit 1
fi
source_sha="$(git rev-parse --verify "${tag_ref}^{commit}")"
checkout_sha="$(git rev-parse --verify "HEAD^{commit}")"
if [[ "$tag_object_sha" != "$EXPECTED_TAG_OBJECT_SHA" ||
  "$source_sha" != "$EXPECTED_TARGET_SHA" ||
  "$checkout_sha" != "$EXPECTED_TARGET_SHA" ||
  "$GITHUB_SHA" != "$EXPECTED_TARGET_SHA" ]]; then
  echo "Release tag object, peeled commit, checkout, event SHA, and expected SHAs must match exactly." >&2
  exit 1
fi
expected_operation_nonce="$(
  BODY_SHA256="$RELEASE_BODY_SHA256" \
    REPOSITORY="$GITHUB_REPOSITORY" \
    SOURCE_SHA="$source_sha" \
    TAG="$RELEASE_TAG" \
    TAG_OBJECT_SHA="$tag_object_sha" \
    node <<'NODE'
const { createHash } = require('node:crypto');
const payload = {
  body_sha256: process.env.BODY_SHA256,
  repo: process.env.REPOSITORY,
  tag: process.env.TAG,
  tag_commit_sha: process.env.SOURCE_SHA,
  tag_object_sha: process.env.TAG_OBJECT_SHA,
};
process.stdout.write(
  createHash('sha256')
    .update(`${JSON.stringify(payload)}\n`)
    .digest('hex')
);
NODE
)"
if [[ "$OPERATION_NONCE" != "$expected_operation_nonce" ]]; then
  echo "operation_nonce does not match the canonical release operation." >&2
  exit 1
fi

{
  echo "resume=$resume"
  echo "source_sha=$source_sha"
  echo "tag_object_sha=$tag_object_sha"
  echo "version=$version"
} >>"$GITHUB_OUTPUT"
