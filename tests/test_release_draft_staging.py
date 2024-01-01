from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from types import ModuleType
from unittest import mock


def _module() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "release_draft_staging.py"
    spec = importlib.util.spec_from_file_location("release_draft_staging", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release = _module()


def _bundle(root: Path) -> Path:
    bundle = root / "bundle"
    (bundle / "image").mkdir(parents=True)
    (bundle / "release-manifest.json").write_text(
        json.dumps(
            {
                "artifacts": [{"path": "image/artifact.bin"}],
                "source_date_epoch": 1_700_000_001,
            }
        ),
        encoding="utf-8",
    )
    (bundle / "registry-metadata.json").write_text("{}\n", encoding="utf-8")
    (bundle / "image" / "artifact.bin").write_bytes(b"artifact bytes")
    return bundle


class ReleaseDraftStagingTests(unittest.TestCase):
    def test_archive_is_deterministic_closed_and_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            root = Path(raw_temp)
            bundle = _bundle(root)
            first = root / "first.zip"
            second = root / "second.zip"

            first_digest = release.create_deterministic_archive(bundle, first)
            second_digest = release.create_deterministic_archive(bundle, second)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(
                first_digest,
                hashlib.sha256(first.read_bytes()).hexdigest(),
            )
            self.assertEqual(second_digest, first_digest)
            extracted = root / "extracted"
            release.extract_verified_archive(first, extracted)
            self.assertEqual(
                (extracted / "image" / "artifact.bin").read_bytes(),
                b"artifact bytes",
            )
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), sorted(archive.namelist()))
                self.assertTrue(
                    all(
                        info.compress_type == zipfile.ZIP_STORED
                        and not info.extra
                        and not info.comment
                        for info in archive.infolist()
                    )
                )

    def test_archive_rejects_file_outside_closed_manifest_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            root = Path(raw_temp)
            bundle = _bundle(root)
            (bundle / "untracked-secret").write_text(
                "must not ship",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                release.ReleaseStagingError,
                "closed manifest",
            ):
                release.create_deterministic_archive(bundle, root / "bundle.zip")

    def test_extraction_rejects_traversal_and_removes_partial_tree(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            root = Path(raw_temp)
            archive_path = root / "unsafe.zip"
            with zipfile.ZipFile(
                archive_path,
                "w",
                compression=zipfile.ZIP_STORED,
            ) as archive:
                info = zipfile.ZipInfo("../escape")
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, b"unsafe")
            destination = root / "output"

            with self.assertRaisesRegex(
                release.ReleaseStagingError,
                "unsafe path",
            ):
                release.extract_verified_archive(archive_path, destination)

            self.assertFalse(destination.exists())
            self.assertFalse((root / "escape").exists())

    def test_asset_redirect_strips_token_and_rejects_untrusted_host(self) -> None:
        request = release.urllib.request.Request(
            "https://api.github.com/repos/VectorMethods/repo/releases/assets/7",
            headers={
                "Authorization": "Bearer secret",
                "Accept": "application/octet-stream",
            },
        )
        handler = release._AssetRedirect()
        redirected = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            http.client.HTTPMessage(),
            "https://release-assets.githubusercontent.com/object",
        )

        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaisesRegex(
            release.ReleaseStagingError,
            "unsafe redirect",
        ):
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                http.client.HTTPMessage(),
                "https://attacker.invalid/object",
            )

    def test_prepare_rejects_partial_resume_identity_before_network(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            root = Path(raw_temp)
            args = Namespace(
                kind="mcp",
                repository="VectorMethods/videovector-mcp-server",
                release_tag="videovector-mcp-v2.0.2",
                expected_target_sha="a" * 40,
                expected_tag_object_sha="d" * 40,
                release_body_sha256="b" * 64,
                draft_release_id="42",
                bundle_source_release_id="41",
                bundle_source_asset_id="",
                bundle_source_sha256="c" * 64,
                bundle=str(root / "bundle"),
                archive=str(root / "release-bundle.zip"),
                github_token_env="GITHUB_TOKEN",
            )

            with self.assertRaisesRegex(
                release.ReleaseStagingError,
                "supplied together",
            ):
                release.prepare(args)

    def test_release_identity_requires_annotated_tag_peeling(self) -> None:
        class Client:
            repository = "VectorMethods/videovector-mcp-server"

            def release(self, release_id: int) -> dict[str, object]:
                return {
                    "id": release_id,
                    "tag_name": "videovector-mcp-v2.0.2",
                    "target_commitish": "a" * 40,
                    "author": {"login": release.BOT_LOGIN},
                    "body": "release body",
                    "prerelease": False,
                    "draft": True,
                    "immutable": False,
                }

            def json(self, method: str, path: str) -> dict[str, object]:
                self_outer.assertEqual(method, "GET")
                if "/git/ref/tags/" in path:
                    return {"object": {"type": "tag", "sha": "d" * 40}}
                return {
                    "tag": "videovector-mcp-v2.0.2",
                    "object": {"type": "commit", "sha": "a" * 40},
                }

        self_outer = self
        release._require_release_identity(
            Client(),
            release_id=42,
            release_tag="videovector-mcp-v2.0.2",
            expected_target_sha="a" * 40,
            expected_tag_object_sha="d" * 40,
            release_body_sha256=hashlib.sha256(b"release body").hexdigest(),
            require_draft=True,
        )

    def test_release_identity_requires_canonical_prerelease_flag(self) -> None:
        class Client:
            repository = "VectorMethods/videovector-mcp-server"

            def release(self, release_id: int) -> dict[str, object]:
                return {
                    "id": release_id,
                    "tag_name": "videovector-mcp-v2.1.0-rc.1",
                    "target_commitish": "a" * 40,
                    "author": {"login": release.BOT_LOGIN},
                    "body": "release body",
                    "prerelease": False,
                    "draft": True,
                    "immutable": False,
                }

            def json(self, method: str, path: str) -> dict[str, object]:
                del method
                if "/git/ref/tags/" in path:
                    return {"object": {"type": "tag", "sha": "d" * 40}}
                return {
                    "tag": "videovector-mcp-v2.1.0-rc.1",
                    "object": {"type": "commit", "sha": "a" * 40},
                }

        with self.assertRaisesRegex(
            release.ReleaseStagingError,
            "identity differs",
        ):
            release._require_release_identity(
                Client(),
                release_id=42,
                release_tag="videovector-mcp-v2.1.0-rc.1",
                expected_target_sha="a" * 40,
                expected_tag_object_sha="d" * 40,
                release_body_sha256=hashlib.sha256(b"release body").hexdigest(),
                require_draft=True,
            )

    def test_uncertain_upload_settles_by_exact_digest_readback(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "release-bundle.zip"
            path.write_bytes(b"durable bundle")

            class Client:
                upload_calls = 0
                visible = False

                def assets(self, release_id: int) -> list[object]:
                    self_outer.assertEqual(release_id, 42)
                    if not self.visible:
                        return []
                    return [
                        release.Asset(
                            asset_id=7,
                            name="release-bundle.zip",
                            state="uploaded",
                            size=path.stat().st_size,
                            digest=f"sha256:{release._sha256_file(path)}",
                            uploader="github-actions[bot]",
                        )
                    ]

                def upload_asset(
                    self,
                    release_id: int,
                    name: str,
                    upload_path: Path,
                    content_type: str,
                ) -> None:
                    self_outer.assertEqual(
                        (release_id, name, upload_path, content_type),
                        (42, "release-bundle.zip", path, "application/zip"),
                    )
                    self.upload_calls += 1
                    self.visible = True
                    raise release.ReleaseStagingError("lost upload response")

            self_outer = self
            client = Client()
            revalidations = 0

            def revalidate() -> None:
                nonlocal revalidations
                revalidations += 1

            with mock.patch.object(release, "SETTLEMENT_INTERVAL_SECONDS", 0):
                release._settle_asset(
                    client,
                    release_id=42,
                    name="release-bundle.zip",
                    path=path,
                    content_type="application/zip",
                    revalidate=revalidate,
                )
            self.assertEqual(client.upload_calls, 1)
            self.assertEqual(revalidations, 1)

    def test_release_workflow_gates_publishers_on_exact_draft_staging(self) -> None:
        workflow = (
            Path(__file__).parents[1] / ".github" / "workflows" / "release.yml"
        ).read_text(encoding="utf-8")
        for name in (
            "draft_release_id",
            "bundle_source_release_id",
            "bundle_source_asset_id",
            "bundle_source_sha256",
        ):
            self.assertIn(f"      {name}:", workflow)
        for retired in (
            "bootstrap_ghcr_public",
            "publish-ghcr",
            "packages: write",
            "docker login",
        ):
            self.assertNotIn(retired, workflow)
        for variable in ("RELEASE_ID", "ASSET_ID", "SHA256"):
            flag = variable.lower().replace("_", "-")
            self.assertIn(
                f'--bundle-source-{flag} "$BUNDLE_SOURCE_{variable}"', workflow
            )
        self.assertEqual(
            workflow.count("if: ${{ needs.guard.outputs.resume != 'true' }}"), 2
        )
        self.assertIn("if: ${{ needs.guard.outputs.resume == 'true' }}", workflow)
        self.assertEqual(workflow.count("release_draft_staging.py materialize"), 2)
        self.assertLess(
            workflow.index("Archive and independently verify the fresh bundle"),
            workflow.index("Upload immutable release bundle"),
        )
        build = workflow[workflow.index("  build:") : workflow.index("  stage-draft:")]
        stage = workflow[
            workflow.index("  stage-draft:") : workflow.index("  publish-npm:")
        ]
        npm = workflow[
            workflow.index("  publish-npm:") : workflow.index("  publish-mcp-registry:")
        ]
        mcp = workflow[workflow.index("  publish-mcp-registry:") :]
        guard = workflow[workflow.index("  guard:") : workflow.index("  build:")]
        self.assertIn("contents: write", build)
        self.assertIn("GITHUB_TOKEN: ${{ github.token }}", build)
        self.assertIn("release_draft_staging.py prepare", build)
        self.assertIn("contents: write", stage)
        self.assertEqual(workflow.count("contents: write"), 2)
        self.assertNotIn("contents: write", guard)
        self.assertNotIn("GITHUB_TOKEN:", guard)
        for publisher in (npm, mcp):
            self.assertNotIn("contents: write", publisher)
            self.assertIn("id-token: write", publisher)
            self.assertIn("release_draft_staging.py materialize", publisher)
            self.assertNotIn("--bundle-source-release-id", publisher)
            self.assertNotIn("if: ${{ needs.guard.outputs.resume", publisher)
            for dependency in ("      - guard", "      - build", "      - stage-draft"):
                self.assertIn(dependency, publisher)
        self.assertIn("      - publish-npm", mcp)
        self.assertNotIn("id-token: write", build)
        self.assertNotIn("secrets.", build)
        self.assertNotIn("NPM_BOOTSTRAP_TOKEN", workflow)
        self.assertEqual(workflow.count("persist-credentials: false"), 5)
        self.assertIn("release_draft_staging.py stage", stage)
        self.assertNotIn("release_draft_staging.py stage", build)
        self.assertIn("    needs: guard", build)
        for dependency in ("      - guard", "      - build"):
            self.assertIn(dependency, stage)
        for job, timeout in (
            (guard, 5),
            (build, 35),
            (stage, 10),
            (npm, 40),
            (mcp, 10),
        ):
            self.assertIn(f"    timeout-minutes: {timeout}", job)
        self.assertLess(5 + 35 + 10 + 40 + 10, 120)
        self.assertEqual(workflow.count('python-version: "3.11.13"'), 4)
        self.assertNotIn("docker/setup-", workflow)
        self.assertIn("Attest the exact staged release assets", stage)
        self.assertIn("release-transport/release-bundle.zip", stage)
        self.assertIn("release-transport/release-manifest.json", stage)
        self.assertIn("release-transport/registry-metadata.json", stage)

    def test_materialize_verifies_the_inner_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            root = Path(raw_temp)
            source = _bundle(root)
            transport = root / "transport"
            archive = transport / "release-bundle.zip"
            release.create_deterministic_archive(source, archive)
            release._complete_transport_directory(archive, source)
            args = Namespace(
                kind="mcp",
                release_tag="videovector-mcp-v2.0.2",
                expected_target_sha="a" * 40,
                expected_tag_object_sha="d" * 40,
                release_body_sha256="b" * 64,
                bundle=str(root / "materialized"),
                archive=str(archive),
            )
            with mock.patch.object(release, "_verify_product_bundle"):
                release.materialize(args)
            self.assertTrue(
                (root / "materialized" / "image" / "artifact.bin").is_file()
            )


if __name__ == "__main__":
    unittest.main()
