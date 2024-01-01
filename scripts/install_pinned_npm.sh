#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  echo "Usage: install_pinned_npm.sh [build|publisher]" >&2
  exit 64
fi
case "${1:-build}" in
  build)
    readonly npm_version="11.15.0"
    readonly npm_archive_sha256="c15ed81d98f5f4c45e30f71e5dcf83ae24e9af5beb5db8b1d58becea97ba38cc"
    ;;
  publisher)
    readonly npm_version="11.21.0"
    readonly npm_archive_sha256="783e7c92bf73b442fb800c2d6ef3921e86da8894a700fed45140e37916877482"
    ;;
  *)
    echo "Usage: install_pinned_npm.sh [build|publisher]" >&2
    exit 64
    ;;
esac
readonly npm_archive_url="https://registry.npmjs.org/npm/-/npm-${npm_version}.tgz"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
chmod 0700 "$temporary_directory"
npm_archive="${temporary_directory}/npm.tgz"

curl \
  --proto '=https' \
  --tlsv1.2 \
  --connect-timeout 10 \
  --max-time 120 \
  --retry 3 \
  --retry-all-errors \
  --fail \
  --silent \
  --show-error \
  --location \
  --output "$npm_archive" \
  "$npm_archive_url"
printf '%s  %s\n' "$npm_archive_sha256" "$npm_archive" | sha256sum --check -
npm install --global --ignore-scripts "$npm_archive"
test "$(npm --version)" = "$npm_version"
