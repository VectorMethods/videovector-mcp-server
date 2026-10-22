# Changelog

## 5.0.0

Breaking MCP catalog release: exactly `analyze`, `get_analysis`, `search`, `import_media`, `save_prompt`, and `browse` on all transports. Profiles and retired aliases are removed; native REST APIs remain independent. Inputs use grouped source/destination/execution/scope fields with root native files, conditional schemas, and examples. OAuth excludes cloud credentials/import/retry and task webhooks at both discovery and execution.

Analysis uses a stable ID, bounded observation, typed next actions, immutable completed-video bundles, and included JSON/segment downloads. Search combines text/image/filters before ranking and retains pinned downloadable snapshots. Imports can run independently; saved prompts and discovery are consolidated. Public revision controls are removed. Direct integrations can request terminal-only callbacks with caller-provided signing secrets.

The shared Studio supports picker, partial progress, and private visible polling. Local streaming retains a separate transfer timeout. Uncertain submissions retain their idempotency identity; completed reads never resubmit work. File persistence and continuation respect host and user controls.

## 4.0.1 — Release metadata parity

- Align package and generated contract metadata with the public 4.0.1 patch release.
- The public release workflow now validates large stdio discovery responses through stdin, preserving the 4.0 application contract.

## 4.0.0 — Standalone imported parts and grounded extraction

This is a breaking contract release paired with the corresponding VideoVector API deployment.

- All ordinary uploads return an asynchronous ImportJob. Wait for import completion before processing.
- Long videos become independently uploaded parts of at most 40 minutes. Each part has its own video ID and local timestamps.
- Enumerate every ordered outputs page, or process with `import_job_id` to select the complete manifest. `video_ids` contains only its current page.
- Import progress distinguishes source files from generated parts and reports ingestion phase and downstream execution readiness.
- `video_level` now contains only `instructions_text` and `json_schema` and requires content-aware segmentation. It is grounded in the same media call as segment fields. Selected-segment input and synthesis-only result fields are removed.

Update existing upload workflows before upgrading: retain `job_id`, wait for completion, and use the complete import selector or all output pages. The shipped examples follow this lifecycle.
