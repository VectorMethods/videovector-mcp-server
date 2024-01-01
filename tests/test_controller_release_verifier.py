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


def _server(version: str) -> dict[str, object]:
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
        ],
        "title": "VideoVector",
        "version": version,
    }


def _npm_artifact(
    path: Path,
    *,
    version: str,
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
    embedded = _server(version)
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


def _full_bundle(root: Path) -> tuple[Path, dict[str, str]]:
    version = "2.0.2"
    source_sha = "a" * 40
    tag_object_sha = "d" * 40
    body_sha = "b" * 64
    bundle = root / "bundle"
    npm_directory = bundle / "npm"
    mcp_directory = bundle / "mcp"
    npm_directory.mkdir(parents=True)
    mcp_directory.mkdir()
    npm_path = npm_directory / f"vectormethods-videovector-mcp-server-{version}.tgz"
    npm_metadata = _npm_artifact(
        npm_path,
        version=version,
    )
    server = _server(version)
    server_path = mcp_directory / "server.json"
    server_path.write_text(
        json.dumps(server, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    registry_metadata = {
        "schema_version": "2.0.0",
        "npm": npm_metadata,
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
                server_path,
                "mcp/server.json",
                "mcp-registry-metadata",
            ),
        ],
        "image_digest": None,
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
    def test_actual_registry_descriptor_matches_the_strict_contract(self) -> None:
        record = json.loads(
            (Path(__file__).parent / "fixtures/mcp-registry-2.1.1.json").read_text()
        )
        actual = record["server"]
        self.assertEqual(verifier._verify_server(actual, actual["version"]), actual)
        descriptor = json.loads((Path(__file__).parents[1] / "server.json").read_text())
        descriptor["version"] = actual["version"]
        descriptor["packages"][0]["version"] = actual["version"]
        self.assertEqual(descriptor, actual)

    def test_registry_optional_fields_and_api_key_flags_remain_exact(self) -> None:
        record = json.loads(
            (Path(__file__).parent / "fixtures/mcp-registry-2.1.1.json").read_text()
        )
        for field, value in (
            ("isRequired", True),
            ("isSecret", True),
            ("isSecret", False),
            ("isRequired", "false"),
            ("isSecret", None),
            ("default", "different-default"),
            ("unknownSetting", True),
        ):
            with self.subTest(field=field, value=value):
                candidate = json.loads(json.dumps(record["server"]))
                candidate["packages"][0]["environmentVariables"][1][field] = value
                with self.assertRaises(verifier.ControllerVerificationError):
                    verifier._verify_server(candidate, candidate["version"])
        for field in ("isRequired", "isSecret"):
            with self.subTest(api_key_field=field):
                candidate = json.loads(json.dumps(record["server"]))
                del candidate["packages"][0]["environmentVariables"][0][field]
                with self.assertRaises(verifier.ControllerVerificationError):
                    verifier._verify_server(candidate, candidate["version"])

    def test_complete_independent_bundle_verification(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            bundle, identity = _full_bundle(Path(raw_temp))
            verifier.verify_bundle(bundle, **identity)

    def test_complete_verifier_rejects_toolchain_provenance_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            bundle, identity = _full_bundle(Path(raw_temp))
            manifest_path = bundle / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["tool_versions"]["npm"] = "latest"
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
            metadata = _npm_artifact(
                path,
                version="2.0.2",
                install_hook=True,
            )
            with self.assertRaisesRegex(
                verifier.ControllerVerificationError, "lifecycle hook"
            ):
                verifier._verify_npm(
                    path,
                    version="2.0.2",
                    metadata=metadata,
                    expected_server=_server("2.0.2"),
                )

    def test_rejects_retired_container_fields_and_artifacts(self) -> None:
        for field in ("image_digest", "ghcr", "oci-artifact"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as raw_temp:
                bundle, identity = _full_bundle(Path(raw_temp))
                manifest_path = bundle / "release-manifest.json"
                manifest = json.loads(manifest_path.read_text())
                if field == "image_digest":
                    manifest["image_digest"] = "sha256:" + "a" * 64
                elif field == "oci-artifact":
                    manifest["artifacts"].append(
                        {
                            "kind": "oci-image",
                            "path": "image/container.tar",
                            "sha256": "a" * 64,
                            "size": 1,
                        }
                    )
                else:
                    metadata_path = bundle / "registry-metadata.json"
                    metadata = json.loads(metadata_path.read_text())
                    metadata["ghcr"] = {"image": "retired"}
                    metadata_path.write_text(json.dumps(metadata))
                    manifest["registry_metadata_sha256"] = hashlib.sha256(
                        metadata_path.read_bytes()
                    ).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaises(verifier.ControllerVerificationError):
                    verifier.verify_bundle(bundle, **identity)

    def test_rejects_container_package_metadata(self) -> None:
        server = _server("2.0.2")
        server["packages"].append({"registryType": "oci", "identifier": "retired"})
        with self.assertRaisesRegex(verifier.ControllerVerificationError, "one npm"):
            verifier._verify_server(server, "2.0.2")

    def test_rejects_different_embedded_npm_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "artifact.tgz"
            metadata = _npm_artifact(path, version="2.0.2")
            expected = _server("2.0.2")
            expected["description"] = "Changed only in registry metadata"
            with self.assertRaisesRegex(
                verifier.ControllerVerificationError, "embedded"
            ):
                verifier._verify_npm(
                    path,
                    version="2.0.2",
                    metadata=metadata,
                    expected_server=expected,
                )


if __name__ == "__main__":
    unittest.main()
