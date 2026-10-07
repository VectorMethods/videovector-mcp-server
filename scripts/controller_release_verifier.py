#!/usr/bin/env python3
"""Independent, bounded verification of MCP release artifact semantics.

This verifier intentionally shares no implementation with the JavaScript
builder or publisher. It uses only the Python standard library, never extracts
or executes artifact code, and streams all package and OCI payloads.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import tarfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import IO, Any, NoReturn, cast

MCP_REPOSITORY = "VectorMethods/videovector-mcp-server"
MCP_PACKAGE = "@vectormethods/videovector-mcp-server"
MCP_NAME = "io.github.VectorMethods/videovector-mcp-server"
MCP_IMAGE = "ghcr.io/vectormethods/videovector-mcp-server"
MCP_SCHEMA = (
    "https://static.modelcontextprotocol.io/schemas/" "2025-12-11/server.schema.json"
)
SHA256 = re.compile(r"[0-9a-f]{64}")
GIT_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
IMAGE_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SEMVER = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
OCI_LAYERS = frozenset(
    {
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
    }
)
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_NPM_BYTES = 256 * 1024 * 1024
MAX_OCI_BYTES = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 40_000
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
REQUIRED_PLATFORMS = (("linux", "amd64"), ("linux", "arm64"))
EXPECTED_IMAGE_ENV = frozenset(
    {
        "NODE_ENV=production",
        "PORT=8080",
        "MCP_TRANSPORT_MODE=stdio",
        "NODE_VERSION=24.14.0",
        "YARN_VERSION=1.22.22",
    }
)
EXPECTED_IMAGE_PATH = (
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)
EXPECTED_SERVER_ENV = [
    {
        "name": "VIDEOVECTOR_API_KEY",
        "description": "VideoVector production API key.",
        "format": "string",
        "isRequired": True,
        "isSecret": True,
    },
    {
        "name": "VIDEOVECTOR_BASE_URL",
        "description": "VideoVector API base URL.",
        "format": "string",
        "isRequired": False,
        "isSecret": False,
        "default": "https://api.vectormethods.com/api/v2",
    },
    {
        "name": "VIDEOVECTOR_TIMEOUT",
        "description": "Per-request timeout in milliseconds.",
        "format": "number",
        "isRequired": False,
        "isSecret": False,
        "default": "90000",
    },
    {
        "name": "VIDEOVECTOR_MAX_RETRIES",
        "description": "Maximum retry count for retryable API failures.",
        "format": "number",
        "isRequired": False,
        "isSecret": False,
        "default": "3",
    },
]


class ControllerVerificationError(RuntimeError):
    """The immutable bundle differs from the independent release contract."""


def _fail(message: str) -> NoReturn:
    raise ControllerVerificationError(message)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label} must be an object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        _fail(f"{label} must be an array")
    return cast(Sequence[Any], value)


def _exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        _fail(f"{label} fields are not canonical")


def _strict_json(payload: bytes, label: str) -> Any:
    if not payload or len(payload) > MAX_JSON_BYTES:
        _fail(f"{label} is outside its byte bound")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                _fail(f"{label} contains duplicate key {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControllerVerificationError(
            f"{label} is invalid JSON: {error}"
        ) from error


def _read_json(path: Path, label: str) -> Any:
    if not path.is_file() or path.is_symlink():
        _fail(f"{label} is missing or unsafe")
    with path.open("rb") as source:
        payload = source.read(MAX_JSON_BYTES + 1)
    return _strict_json(payload, label)


def _safe_name(raw: str, label: str) -> str:
    name = raw.rstrip("/")
    parsed = PurePosixPath(name)
    if (
        not name
        or raw.startswith("/")
        or "\\" in raw
        or "\x00" in raw
        or str(parsed) != name
        or any(part in {"", ".", ".."} for part in parsed.parts)
    ):
        _fail(f"{label} contains unsafe path {raw!r}")
    return name


def _stream_hashes(source: IO[bytes], size: int, label: str) -> tuple[str, str, str]:
    if size < 0 or size > MAX_EXPANDED_BYTES:
        _fail(f"{label} is outside its byte bound")
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    sha512 = hashlib.sha512()
    observed = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        observed += len(chunk)
        if observed > size:
            _fail(f"{label} exceeds its declared size")
        sha1.update(chunk)
        sha256.update(chunk)
        sha512.update(chunk)
    if observed != size:
        _fail(f"{label} size differs")
    return (
        sha1.hexdigest(),
        sha256.hexdigest(),
        base64.b64encode(sha512.digest()).decode("ascii"),
    )


def _file_hashes(path: Path, limit: int, label: str) -> tuple[int, str, str, str]:
    if not path.is_file() or path.is_symlink():
        _fail(f"{label} is missing or unsafe")
    size = path.stat().st_size
    if size <= 0 or size > limit:
        _fail(f"{label} is outside its byte bound")
    with path.open("rb") as source:
        sha1, sha256, sha512 = _stream_hashes(source, size, label)
    return size, sha1, sha256, sha512


def _canonical_semver(version: str) -> bool:
    match = SEMVER.fullmatch(version)
    return match is not None and not any(
        item.isdigit() and len(item) > 1 and item.startswith("0")
        for item in (match.group(1) or "").split(".")
    )


def _verify_server(
    server: Any, version: str, image_digest: str | None
) -> Mapping[str, Any]:
    value = _mapping(server, "server.json")
    _exact_keys(
        value,
        {"$schema", "description", "name", "packages", "title", "version"},
        "server.json",
    )
    if (
        value.get("$schema") != MCP_SCHEMA
        or value.get("name") != MCP_NAME
        or value.get("version") != version
        or not isinstance(value.get("title"), str)
        or not value["title"]
        or not isinstance(value.get("description"), str)
        or not value["description"]
    ):
        _fail("server.json identity differs")
    packages = _sequence(value.get("packages"), "server.json packages")
    if len(packages) != 2:
        _fail("server.json must contain exactly two packages")
    by_type: dict[str, Mapping[str, Any]] = {}
    for raw in packages:
        package = _mapping(raw, "server.json package")
        kind = package.get("registryType")
        if kind not in {"npm", "oci"} or kind in by_type:
            _fail("server.json package registry identity is invalid")
        expected_keys = {
            "environmentVariables",
            "identifier",
            "registryType",
            "transport",
        }
        if kind == "npm":
            expected_keys.add("version")
        _exact_keys(package, expected_keys, f"server.json {kind} package")
        if package.get("transport") != {"type": "stdio"}:
            _fail(f"server.json {kind} transport differs")
        if package.get("environmentVariables") != EXPECTED_SERVER_ENV:
            _fail(f"server.json {kind} environment contract differs")
        by_type[str(kind)] = package
    expected_oci = (
        f"{MCP_IMAGE}:{version}"
        if image_digest is None
        else f"{MCP_IMAGE}@{image_digest}"
    )
    if (
        by_type["npm"].get("identifier") != MCP_PACKAGE
        or by_type["npm"].get("version") != version
        or by_type["oci"].get("identifier") != expected_oci
        or by_type["npm"].get("environmentVariables")
        != by_type["oci"].get("environmentVariables")
    ):
        _fail("server.json package identity or environment differs")
    return value


def _verify_npm(
    path: Path,
    *,
    version: str,
    image_digest: str,
    metadata: Mapping[str, Any],
    expected_server: Mapping[str, Any],
) -> None:
    size, sha1, sha256, sha512 = _file_hashes(path, MAX_NPM_BYTES, "npm artifact")
    tarball = _mapping(metadata.get("tarball"), "npm tarball metadata")
    _exact_keys(
        tarball,
        {"filename", "sha1", "sha256", "sha512", "size"},
        "npm tarball metadata",
    )
    if tarball != {
        "filename": path.name,
        "sha1": sha1,
        "sha256": sha256,
        "sha512": sha512,
        "size": size,
    }:
        _fail("npm registry hashes differ from the exact tarball")
    seen: set[str] = set()
    captured: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    expanded = 0
    try:
        with tarfile.open(path, "r:gz") as archive:
            for index, member in enumerate(archive, 1):
                if index > MAX_ENTRIES:
                    _fail("npm archive entry count exceeds its bound")
                name = _safe_name(member.name, "npm archive")
                if name in seen or PurePosixPath(name).parts[0] != "package":
                    _fail("npm archive contains duplicate or out-of-root path")
                seen.add(name)
                if member.isdir():
                    continue
                if not member.isfile():
                    _fail(f"npm archive entry {name!r} is not regular")
                expanded += member.size
                if expanded > MAX_EXPANDED_BYTES:
                    _fail("npm expanded bytes exceed the controller bound")
                source = archive.extractfile(member)
                if source is None:
                    _fail(f"npm archive entry {name!r} cannot be read")
                with source:
                    payload = (
                        source.read(MAX_JSON_BYTES + 1)
                        if member.size <= MAX_JSON_BYTES
                        else None
                    )
                    if payload is None:
                        _stream_hashes(source, member.size, name)
                    elif len(payload) != member.size:
                        _fail(f"npm archive entry {name!r} size differs")
                if payload is not None:
                    captured[name] = payload
                modes[name] = member.mode
    except (tarfile.TarError, EOFError, OSError) as error:
        raise ControllerVerificationError(f"npm archive is invalid: {error}") from error
    package_bytes = captured.get("package/package.json")
    server_bytes = captured.get("package/server.json")
    executable = captured.get("package/dist/index.js")
    if package_bytes is None or server_bytes is None or not executable:
        _fail("npm artifact is missing package.json, server.json, or executable")
    package = _mapping(
        _strict_json(package_bytes, "npm package.json"), "npm package.json"
    )
    if (
        package.get("name") != MCP_PACKAGE
        or package.get("version") != version
        or package.get("mcpName") != MCP_NAME
        or package.get("bin") != {"videovector-mcp": "dist/index.js"}
        or package.get("bin") != metadata.get("bin")
        or package.get("engines") != metadata.get("engines")
        or package.get("engines") != {"node": ">=18.0.0"}
        or package.get("packageManager") != "npm@11.15.0"
        or modes["package/dist/index.js"] & 0o111 == 0
    ):
        _fail("npm artifact identity or executable contract differs")
    scripts = _mapping(package.get("scripts", {}), "npm scripts")
    if {"preinstall", "install", "postinstall", "prepare"} & set(scripts):
        _fail("npm artifact contains an install-time lifecycle hook")
    embedded = json.loads(
        json.dumps(
            _verify_server(
                _strict_json(server_bytes, "embedded server.json"), version, None
            )
        )
    )
    for package_entry in embedded["packages"]:
        if package_entry["registryType"] == "oci":
            package_entry["identifier"] = f"{MCP_IMAGE}@{image_digest}"
    if embedded != expected_server:
        _fail("npm embedded server metadata differs")


def _verify_oci(
    path: Path,
    *,
    expected_digest: str,
    source_sha: str,
    version: str,
    metadata: Mapping[str, Any],
) -> None:
    size = path.stat().st_size if path.is_file() and not path.is_symlink() else 0
    if size <= 0 or size > MAX_OCI_BYTES:
        _fail("OCI artifact is outside the controller byte bound")
    expected_labels = {
        "io.modelcontextprotocol.server.name": MCP_NAME,
        "org.opencontainers.image.revision": source_sha,
        "org.opencontainers.image.source": f"https://github.com/{MCP_REPOSITORY}",
        "org.opencontainers.image.version": version,
    }
    try:
        with tarfile.open(path, "r:") as archive:
            members: dict[str, tarfile.TarInfo] = {}
            blobs: dict[str, tarfile.TarInfo] = {}
            expanded = 0
            for index, member in enumerate(archive, 1):
                if index > MAX_ENTRIES:
                    _fail("OCI entry count exceeds the controller bound")
                name = _safe_name(member.name, "OCI archive")
                if name in members:
                    _fail(f"OCI archive contains duplicate path {name!r}")
                members[name] = member
                if member.isdir():
                    if name not in {"blobs", "blobs/sha256"}:
                        _fail(f"OCI archive contains unexpected directory {name!r}")
                    continue
                if not member.isfile():
                    _fail(f"OCI archive entry {name!r} is not regular")
                expanded += member.size
                if expanded > MAX_EXPANDED_BYTES:
                    _fail("OCI expanded bytes exceed the controller bound")
                match = re.fullmatch(r"blobs/sha256/([0-9a-f]{64})", name)
                if name not in {"index.json", "oci-layout"} and match is None:
                    _fail(f"OCI archive contains unexpected path {name!r}")
                if match is not None:
                    blobs[match.group(1)] = member
            if not {"index.json", "oci-layout"} <= set(members):
                _fail("OCI archive is missing layout controls")

            def read_member(member: tarfile.TarInfo, label: str) -> bytes:
                if member.size <= 0 or member.size > MAX_JSON_BYTES:
                    _fail(f"{label} is outside its JSON byte bound")
                source = archive.extractfile(member)
                if source is None:
                    _fail(f"{label} cannot be read")
                with source:
                    payload = source.read(MAX_JSON_BYTES + 1)
                if len(payload) != member.size:
                    _fail(f"{label} size differs")
                return payload

            def blob(descriptor_raw: Any, label: str, capture: bool) -> bytes | None:
                descriptor = _mapping(descriptor_raw, f"{label} descriptor")
                digest = descriptor.get("digest")
                descriptor_size = descriptor.get("size")
                if (
                    not isinstance(digest, str)
                    or IMAGE_DIGEST.fullmatch(digest) is None
                    or isinstance(descriptor_size, bool)
                    or not isinstance(descriptor_size, int)
                    or descriptor_size <= 0
                ):
                    _fail(f"{label} descriptor is invalid")
                member = blobs.get(digest.removeprefix("sha256:"))
                if member is None or member.size != descriptor_size:
                    _fail(f"{label} blob is missing or has a different size")
                source = archive.extractfile(member)
                if source is None:
                    _fail(f"{label} blob cannot be read")
                with source:
                    if capture:
                        if descriptor_size > MAX_JSON_BYTES:
                            _fail(f"{label} JSON exceeds its bound")
                        payload = source.read(MAX_JSON_BYTES + 1)
                        observed = hashlib.sha256(payload).hexdigest()
                    else:
                        _, observed, _ = _stream_hashes(source, descriptor_size, label)
                        payload = None
                if observed != digest.removeprefix("sha256:"):
                    _fail(f"{label} blob digest differs")
                referenced.add(digest.removeprefix("sha256:"))
                return payload

            layout = _strict_json(
                read_member(members["oci-layout"], "oci-layout"), "oci-layout"
            )
            if layout != {"imageLayoutVersion": "1.0.0"}:
                _fail("OCI layout version differs")
            outer = _mapping(
                _strict_json(
                    read_member(members["index.json"], "outer OCI index"),
                    "outer OCI index",
                ),
                "outer OCI index",
            )
            roots = _sequence(outer.get("manifests"), "outer OCI manifests")
            if len(roots) != 1:
                _fail("OCI archive must have exactly one root descriptor")
            root_descriptor = _mapping(roots[0], "OCI root descriptor")
            if root_descriptor.get("mediaType") != OCI_INDEX:
                _fail("OCI root media type differs")
            referenced: set[str] = set()
            root = _mapping(
                _strict_json(
                    blob(root_descriptor, "OCI root", True) or b"", "OCI root"
                ),
                "OCI root",
            )
            platforms: list[dict[str, str]] = []
            observed_platforms: set[tuple[str, str]] = set()
            for raw_descriptor in _sequence(root.get("manifests"), "OCI platforms"):
                descriptor = _mapping(raw_descriptor, "OCI platform descriptor")
                platform = _mapping(descriptor.get("platform"), "OCI platform")
                identity = (str(platform.get("os")), str(platform.get("architecture")))
                if identity not in REQUIRED_PLATFORMS or identity in observed_platforms:
                    _fail("OCI platform is unsupported or duplicated")
                observed_platforms.add(identity)
                if descriptor.get("mediaType") != OCI_MANIFEST:
                    _fail("OCI platform manifest media type differs")
                manifest = _mapping(
                    _strict_json(
                        blob(descriptor, "OCI manifest", True) or b"", "OCI manifest"
                    ),
                    "OCI manifest",
                )
                config_descriptor = _mapping(
                    manifest.get("config"), "OCI config descriptor"
                )
                if config_descriptor.get("mediaType") != OCI_CONFIG:
                    _fail("OCI config media type differs")
                for layer in _sequence(manifest.get("layers"), "OCI layers"):
                    layer_descriptor = _mapping(layer, "OCI layer descriptor")
                    if layer_descriptor.get("mediaType") not in OCI_LAYERS:
                        _fail("OCI layer media type differs")
                    blob(layer_descriptor, "OCI layer", False)
                config = _mapping(
                    _strict_json(
                        blob(config_descriptor, "OCI config", True) or b"", "OCI config"
                    ),
                    "OCI config",
                )
                runtime = _mapping(config.get("config"), "OCI runtime config")
                env = _sequence(runtime.get("Env"), "OCI Env")
                env_values = {str(value) for value in env}
                required_path = [
                    value for value in env_values if value.startswith("PATH=")
                ]
                if (
                    len(env_values) != len(env)
                    or len(required_path) != 1
                    or required_path[0] != EXPECTED_IMAGE_PATH
                    or env_values - set(required_path) != EXPECTED_IMAGE_ENV
                    or config.get("os") != identity[0]
                    or config.get("architecture") != identity[1]
                    or runtime.get("Labels") != expected_labels
                    or runtime.get("Cmd") != ["node", "dist/index.js"]
                    or runtime.get("WorkingDir") != "/app"
                    or runtime.get("User") != "node"
                    or runtime.get("Entrypoint") not in {None}
                ):
                    _fail("OCI runtime environment, platform, or labels differ")
                platforms.append(
                    {
                        "architecture": identity[1],
                        "config_digest": str(config_descriptor["digest"]),
                        "manifest_digest": str(descriptor["digest"]),
                        "os": identity[0],
                    }
                )
            if observed_platforms != set(REQUIRED_PLATFORMS) or referenced != set(
                blobs
            ):
                _fail("OCI platform set or closed blob inventory differs")
    except (tarfile.TarError, EOFError, OSError) as error:
        raise ControllerVerificationError(f"OCI archive is invalid: {error}") from error
    platforms.sort(key=lambda item: (item["os"], item["architecture"]))
    if root_descriptor.get("digest") != expected_digest or metadata != {
        "image": MCP_IMAGE,
        "tag": version,
        "digest": expected_digest,
        "media_type": OCI_INDEX,
        "platforms": platforms,
        "labels": expected_labels,
    }:
        _fail("OCI registry metadata differs from the exact image")


def verify_bundle(
    bundle: Path,
    *,
    release_tag: str,
    source_sha: str,
    tag_object_sha: str,
    release_body_sha256: str,
) -> None:
    bundle = bundle.resolve(strict=True)
    manifest = _mapping(
        _read_json(bundle / "release-manifest.json", "release manifest"),
        "release manifest",
    )
    metadata = _mapping(
        _read_json(bundle / "registry-metadata.json", "registry metadata"),
        "registry metadata",
    )
    _exact_keys(
        manifest,
        {
            "artifacts",
            "image_digest",
            "package",
            "registry_metadata_path",
            "registry_metadata_sha256",
            "release_body_sha256",
            "repository",
            "schema_version",
            "source_date_epoch",
            "source_sha",
            "tag",
            "tag_commit_sha",
            "tag_object_sha",
            "tool_versions",
        },
        "release manifest",
    )
    package = _mapping(manifest.get("package"), "release package")
    version = package.get("version")
    image_digest = manifest.get("image_digest")
    metadata_sha256 = _file_hashes(
        bundle / "registry-metadata.json",
        MAX_JSON_BYTES,
        "registry metadata",
    )[2]
    if (
        not isinstance(version, str)
        or not _canonical_semver(version)
        or package != {"name": MCP_PACKAGE, "version": version}
        or manifest.get("schema_version") != "2.0.0"
        or manifest.get("repository") != MCP_REPOSITORY
        or manifest.get("tag") != release_tag
        or release_tag != f"videovector-mcp-v{version}"
        or manifest.get("source_sha") != source_sha
        or manifest.get("tag_commit_sha") != source_sha
        or manifest.get("tag_object_sha") != tag_object_sha
        or not GIT_SHA.fullmatch(source_sha)
        or not GIT_SHA.fullmatch(tag_object_sha)
        or tag_object_sha == source_sha
        or manifest.get("release_body_sha256") != release_body_sha256
        or not SHA256.fullmatch(release_body_sha256)
        or manifest.get("registry_metadata_sha256") != metadata_sha256
        or isinstance(manifest.get("source_date_epoch"), bool)
        or not isinstance(manifest.get("source_date_epoch"), int)
        or manifest["source_date_epoch"] <= 0
        or not isinstance(image_digest, str)
        or IMAGE_DIGEST.fullmatch(image_digest) is None
        or manifest.get("tool_versions")
        != {
            "docker": "29.1.3",
            "docker_buildx": "0.28.0",
            "node": "24.14.0",
            "npm": "11.15.0",
        }
    ):
        _fail("release provenance identity differs")
    _exact_keys(
        metadata, {"schema_version", "npm", "ghcr", "mcp_registry"}, "registry metadata"
    )
    if metadata.get("schema_version") != "2.0.0":
        _fail("registry metadata schema differs")
    npm_metadata = _mapping(metadata.get("npm"), "npm metadata")
    ghcr_metadata = _mapping(metadata.get("ghcr"), "GHCR metadata")
    mcp_metadata = _mapping(metadata.get("mcp_registry"), "MCP Registry metadata")
    _exact_keys(
        npm_metadata,
        {"name", "version", "mcpName", "bin", "engines", "tarball"},
        "npm metadata",
    )
    _exact_keys(
        ghcr_metadata,
        {"image", "tag", "digest", "media_type", "platforms", "labels"},
        "GHCR metadata",
    )
    _exact_keys(
        mcp_metadata,
        {"server", "server_json_sha256"},
        "MCP Registry metadata",
    )
    if (
        npm_metadata.get("name") != MCP_PACKAGE
        or npm_metadata.get("version") != version
        or npm_metadata.get("mcpName") != MCP_NAME
        or manifest.get("registry_metadata_path") != "registry-metadata.json"
    ):
        _fail("registry identity differs")
    artifacts = _sequence(manifest.get("artifacts"), "release artifacts")
    by_kind: dict[str, tuple[Mapping[str, Any], Path]] = {}
    expected_files = {"release-manifest.json", "registry-metadata.json"}
    for raw in artifacts:
        descriptor = _mapping(raw, "artifact descriptor")
        _exact_keys(
            descriptor, {"kind", "path", "sha256", "size"}, "artifact descriptor"
        )
        kind = descriptor.get("kind")
        relative = descriptor.get("path")
        if (
            kind not in {"npm-tarball", "oci-image", "mcp-registry-metadata"}
            or kind in by_kind
            or not isinstance(relative, str)
            or _safe_name(relative, "artifact path") != relative
        ):
            _fail("artifact identity is invalid or duplicated")
        expected_path = {
            "npm-tarball": f"npm/vectormethods-videovector-mcp-server-{version}.tgz",
            "oci-image": "image/videovector-mcp-server.oci.tar",
            "mcp-registry-metadata": "mcp/server.json",
        }[str(kind)]
        if relative != expected_path:
            _fail(f"{kind} artifact path is not canonical")
        target = (bundle / relative).resolve(strict=True)
        if not target.is_relative_to(bundle):
            _fail("artifact path escapes the bundle")
        limit = {
            "npm-tarball": MAX_NPM_BYTES,
            "oci-image": MAX_OCI_BYTES,
            "mcp-registry-metadata": MAX_JSON_BYTES,
        }[str(kind)]
        size, _, digest, _ = _file_hashes(target, limit, f"{kind} artifact")
        if descriptor.get("size") != size or descriptor.get("sha256") != digest:
            _fail(f"{kind} descriptor differs from its bytes")
        by_kind[str(kind)] = (descriptor, target)
        expected_files.add(relative)
    actual_files = {
        candidate.relative_to(bundle).as_posix()
        for candidate in bundle.rglob("*")
        if candidate.is_file() and not candidate.is_symlink()
    }
    if (
        set(by_kind) != {"npm-tarball", "oci-image", "mcp-registry-metadata"}
        or actual_files != expected_files
    ):
        _fail("release artifact or filesystem inventory is not closed")
    server_path = by_kind["mcp-registry-metadata"][1]
    server = _verify_server(
        _read_json(server_path, "immutable server.json"), version, image_digest
    )
    if mcp_metadata.get("server") != server or mcp_metadata.get(
        "server_json_sha256"
    ) != by_kind["mcp-registry-metadata"][0].get("sha256"):
        _fail("MCP Registry metadata differs from server.json")
    _verify_npm(
        by_kind["npm-tarball"][1],
        version=version,
        image_digest=image_digest,
        metadata=npm_metadata,
        expected_server=server,
    )
    _verify_oci(
        by_kind["oci-image"][1],
        expected_digest=image_digest,
        source_sha=source_sha,
        version=version,
        metadata=ghcr_metadata,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--tag-object-sha", required=True)
    parser.add_argument("--release-body-sha256", required=True)
    args = parser.parse_args()
    try:
        verify_bundle(
            args.bundle,
            release_tag=args.release_tag,
            source_sha=args.source_sha,
            tag_object_sha=args.tag_object_sha,
            release_body_sha256=args.release_body_sha256,
        )
    except (ControllerVerificationError, OSError) as error:
        print(f"[controller-verifier] {error}", file=__import__("sys").stderr)
        return 1
    print("controller-verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
