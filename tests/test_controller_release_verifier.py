from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


def _module() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "controller_release_verifier.py"
    spec = importlib.util.spec_from_file_location("controller_release_verifier", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verifier = _module()


def _server(version: str, digest: str | None) -> dict[str, object]:
    oci_identifier = (
        f"{verifier.MCP_IMAGE}:{version}"
        if digest is None
        else f"{verifier.MCP_IMAGE}@{digest}"
    )
    return {
        "$schema": verifier.MCP_SCHEMA,
        "description": "VideoVector MCP server.",
        "name": verifier.MCP_NAME,
        "packages": [
            {
                "environmentVariables": verifier.EXPECTED_SERVER_ENV,
                "identifier": verifier.MCP_PACKAGE,
                "registryType": "npm",
                "transport": {"type": "stdio"},
                "version": version,
            },
            {
                "environmentVariables": verifier.EXPECTED_SERVER_ENV,
                "identifier": oci_identifier,
                "registryType": "oci",
                "transport": {"type": "stdio"},
            },
        ],
        "title": "VideoVector",
        "version": version,
    }


def _npm_artifact(
    path: Path,
    *,
    version: str,
    image_digest: str,
    install_hook: bool = False,
) -> dict[str, object]:
    package = {
        "name": verifier.MCP_PACKAGE,
        "version": version,
        "mcpName": verifier.MCP_NAME,
        "bin": {"videovector-mcp": "dist/index.js"},
        "engines": {"node": ">=18.0.0"},
        "packageManager": "npm@11.15.0",
        "scripts": {"install": "node attacker.js"} if install_hook else {},
    }
    embedded = _server(version, None)
    with tarfile.open(path, "w:gz") as archive:
        for name, payload, mode in (
            (
                "package/package.json",
                json.dumps(package, separators=(",", ":")).encode(),
                0o644,
            ),
            (
                "package/server.json",
                json.dumps(embedded, separators=(",", ":")).encode(),
                0o644,
            ),
            ("package/dist/index.js", b"#!/usr/bin/env node\n", 0o755),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = mode
            archive.addfile(info, io.BytesIO(payload))
    payload = path.read_bytes()
    return {
        "name": verifier.MCP_PACKAGE,
        "version": version,
        "mcpName": verifier.MCP_NAME,
        "bin": package["bin"],
        "engines": package["engines"],
        "tarball": {
            "filename": path.name,
            "sha1": hashlib.sha1(payload).hexdigest(),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "sha512": base64.b64encode(hashlib.sha512(payload).digest()).decode(),
            "size": len(payload),
        },
    }


def _blob(payload: bytes) -> tuple[str, dict[str, object]]:
    digest = hashlib.sha256(payload).hexdigest()
    return digest, {
        "digest": f"sha256:{digest}",
        "size": len(payload),
    }


def _oci_artifact(
    path: Path,
    *,
    source_sha: str,
    version: str,
    extra_blob: bool = False,
) -> tuple[str, dict[str, object]]:
    labels = {
        "io.modelcontextprotocol.server.name": verifier.MCP_NAME,
        "org.opencontainers.image.revision": source_sha,
        "org.opencontainers.image.source": (
            f"https://github.com/{verifier.MCP_REPOSITORY}"
        ),
        "org.opencontainers.image.version": version,
    }
    blobs: dict[str, bytes] = {}
    layer_bytes = b"canonical-layer"
    layer_digest, layer_descriptor = _blob(layer_bytes)
    layer_descriptor["mediaType"] = "application/vnd.oci.image.layer.v1.tar"
    blobs[layer_digest] = layer_bytes
    platform_descriptors = []
    platform_projection = []
    for architecture in ("amd64", "arm64"):
        config = {
            "architecture": architecture,
            "os": "linux",
            "config": {
                "Cmd": ["node", "dist/index.js"],
                "Entrypoint": None,
                "Env": [
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".join(
                        ("PATH=", "")
                    ),
                    "NODE_VERSION=24.14.0",
                    "YARN_VERSION=1.22.22",
                    "NODE_ENV=production",
                    "PORT=8080",
                    "MCP_TRANSPORT_MODE=stdio",
                ],
                "Labels": labels,
                "User": "node",
                "WorkingDir": "/app",
            },
        }
        config_bytes = json.dumps(
            config, sort_keys=True, separators=(",", ":")
        ).encode()
        config_digest, config_descriptor = _blob(config_bytes)
        config_descriptor["mediaType"] = verifier.OCI_CONFIG
        blobs[config_digest] = config_bytes
        manifest = {
            "schemaVersion": 2,
            "mediaType": verifier.OCI_MANIFEST,
            "config": config_descriptor,
            "layers": [layer_descriptor],
        }
        manifest_bytes = json.dumps(
            manifest, sort_keys=True, separators=(",", ":")
        ).encode()
        manifest_digest, manifest_descriptor = _blob(manifest_bytes)
        manifest_descriptor.update(
            {
                "mediaType": verifier.OCI_MANIFEST,
                "platform": {"architecture": architecture, "os": "linux"},
            }
        )
        blobs[manifest_digest] = manifest_bytes
        platform_descriptors.append(manifest_descriptor)
        platform_projection.append(
            {
                "architecture": architecture,
                "config_digest": config_descriptor["digest"],
                "manifest_digest": manifest_descriptor["digest"],
                "os": "linux",
            }
        )
    root = {
        "schemaVersion": 2,
        "mediaType": verifier.OCI_INDEX,
        "manifests": platform_descriptors,
    }
    root_bytes = json.dumps(root, sort_keys=True, separators=(",", ":")).encode()
    root_digest, root_descriptor = _blob(root_bytes)
    root_descriptor["mediaType"] = verifier.OCI_INDEX
    blobs[root_digest] = root_bytes
    outer = {
        "schemaVersion": 2,
        "manifests": [root_descriptor],
    }
    files = {
        "index.json": json.dumps(outer, separators=(",", ":")).encode(),
        "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
        **{f"blobs/sha256/{digest}": payload for digest, payload in blobs.items()},
    }
    if extra_blob:
        files[f"blobs/sha256/{'f' * 64}"] = b"unreferenced"
    with tarfile.open(path, "w:") as archive:
        for directory in ("blobs", "blobs/sha256"):
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        for name, payload in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))
    platform_projection.sort(key=lambda item: str(item["architecture"]))
    return f"sha256:{root_digest}", {
        "image": verifier.MCP_IMAGE,
        "tag": version,
        "digest": f"sha256:{root_digest}",
        "media_type": verifier.OCI_INDEX,
        "platforms": platform_projection,
        "labels": labels,
    }


def _full_bundle(root: Path) -> tuple[Path, dict[str, str]]:
    version = "2.0.2"
    source_sha = "a" * 40
    tag_object_sha = "d" * 40
    body_sha = "b" * 64
    bundle = root / "bundle"
    npm_directory = bundle / "npm"
    image_directory = bundle / "image"
    mcp_directory = bundle / "mcp"
    npm_directory.mkdir(parents=True)
    image_directory.mkdir()
    mcp_directory.mkdir()
    image_path = image_directory / "videovector-mcp-server.oci.tar"
    image_digest, ghcr_metadata = _oci_artifact(
        image_path,
        source_sha=source_sha,
        version=version,
    )
    npm_path = npm_directory / f"vectormethods-videovector-mcp-server-{version}.tgz"
    npm_metadata = _npm_artifact(
        npm_path,
        version=version,
        image_digest=image_digest,
    )
    server = _server(version, image_digest)
    server_path = mcp_directory / "server.json"
    server_path.write_text(
        json.dumps(server, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    registry_metadata = {
        "schema_version": "2.0.0",
        "npm": npm_metadata,
        "ghcr": ghcr_metadata,
        "mcp_registry": {
            "server": server,
            "server_json_sha256": hashlib.sha256(server_path.read_bytes()).hexdigest(),
        },
    }
    registry_path = bundle / "registry-metadata.json"
    registry_path.write_text(
        json.dumps(registry_metadata, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )

    def descriptor(path: Path, relative: str, kind: str) -> dict[str, object]:
        return {
            "kind": kind,
            "path": relative,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size": path.stat().st_size,
        }

    manifest = {
        "artifacts": [
            descriptor(
                npm_path,
                f"npm/{npm_path.name}",
                "npm-tarball",
            ),
            descriptor(
                image_path,
                "image/videovector-mcp-server.oci.tar",
                "oci-image",
            ),
            descriptor(
                server_path,
                "mcp/server.json",
                "mcp-registry-metadata",
            ),
        ],
        "image_digest": image_digest,
        "package": {"name": verifier.MCP_PACKAGE, "version": version},
        "registry_metadata_path": "registry-metadata.json",
        "registry_metadata_sha256": hashlib.sha256(
            registry_path.read_bytes()
        ).hexdigest(),
        "release_body_sha256": body_sha,
        "repository": verifier.MCP_REPOSITORY,
        "schema_version": "2.0.0",
        "source_date_epoch": 1_700_000_000,
        "source_sha": source_sha,
        "tag": f"videovector-mcp-v{version}",
        "tag_commit_sha": source_sha,
        "tag_object_sha": tag_object_sha,
        "tool_versions": {
            "docker": "29.1.3",
            "docker_buildx": "0.28.0",
            "node": "24.14.0",
            "npm": "11.15.0",
        },
    }
    (bundle / "release-manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return bundle, {
        "release_tag": f"videovector-mcp-v{version}",
        "source_sha": source_sha,
        "tag_object_sha": tag_object_sha,
        "release_body_sha256": body_sha,
    }


class ControllerReleaseVerifierTests(unittest.TestCase):
    def test_complete_independent_bundle_verification(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            bundle, identity = _full_bundle(Path(raw_temp))
            verifier.verify_bundle(bundle, **identity)

    def test_complete_verifier_rejects_toolchain_provenance_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            bundle, identity = _full_bundle(Path(raw_temp))
            manifest_path = bundle / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["tool_versions"]["docker"] = "latest"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(
                verifier.ControllerVerificationError, "provenance identity"
            ):
                verifier.verify_bundle(bundle, **identity)

    def test_rejects_duplicate_json_keys(self) -> None:
        with self.assertRaisesRegex(
            verifier.ControllerVerificationError, "duplicate key"
        ):
            verifier._strict_json(b'{"name":"first","name":"second"}', "fixture")

    def test_rejects_unsafe_archive_paths(self) -> None:
        for name in ("../escape", "/absolute", r"package\\escape"):
            with self.subTest(name=name), self.assertRaises(
                verifier.ControllerVerificationError
            ):
                verifier._safe_name(name, "fixture")

    def test_npm_verifier_rejects_install_time_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "artifact.tgz"
            digest = f"sha256:{'a' * 64}"
            metadata = _npm_artifact(
                path,
                version="2.0.2",
                image_digest=digest,
                install_hook=True,
            )
            with self.assertRaisesRegex(
                verifier.ControllerVerificationError, "lifecycle hook"
            ):
                verifier._verify_npm(
                    path,
                    version="2.0.2",
                    image_digest=digest,
                    metadata=metadata,
                    expected_server=_server("2.0.2", digest),
                )

    def test_oci_verifier_streams_a_closed_exact_layout(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "image.oci.tar"
            source_sha = "a" * 40
            digest, metadata = _oci_artifact(
                path, source_sha=source_sha, version="2.0.2"
            )
            verifier._verify_oci(
                path,
                expected_digest=digest,
                source_sha=source_sha,
                version="2.0.2",
                metadata=metadata,
            )

    def test_oci_verifier_rejects_unreferenced_blob(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "image.oci.tar"
            source_sha = "a" * 40
            digest, metadata = _oci_artifact(
                path,
                source_sha=source_sha,
                version="2.0.2",
                extra_blob=True,
            )
            with self.assertRaisesRegex(
                verifier.ControllerVerificationError, "closed blob inventory"
            ):
                verifier._verify_oci(
                    path,
                    expected_digest=digest,
                    source_sha=source_sha,
                    version="2.0.2",
                    metadata=metadata,
                )


if __name__ == "__main__":
    unittest.main()
