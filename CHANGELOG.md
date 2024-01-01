# 7.0.0 unified extraction contract

- Require segment and whole-media schemas and extract both scopes together, including images.
- Remove fixed segmentation, prompt selection filters, and separate whole-media execution states.
- Return extraction results through one page and cursor; keep downstream conditional search.

# Changelog

## 7.0.0

- Remove the standalone `save_prompt` tool. Analyses already save generated prompts; return their verified identity as `scope.prompt_id` for reuse. The public catalog now contains five tools.
- Give each tool a short, distinct purpose: extraction, result loading, large-collection search, transfer-only imports, or resource discovery. General Q&A uses loaded analysis results.

- Keep internal task identifiers and transfer details out of user-facing replies, including interrupted observations; provide the returned JSON download link when available.
- Shorten the bundled analysis skill with concrete extraction examples and continued polling through terminal completion.

## 6.1.6

- Preserve an accepted analysis's existing Studio link when its first status read times out or returns recoverable observation guidance. Keep the same task identity without replaying submission.

## 6.1.5

- Add stable links to open processing and historical analyses in VideoVector Studio, preserving the exact run and media.
- Return clip links before optional local downloads, and keep internal identifiers out of ordinary replies.
- Preserve compatibility with cached 6.1.4 analysis output schemas.

## 6.1.4

Deliver tool errors as text JSON without applying the successful result schema. Preserve error guidance, task identifiers, retry keys, and OAuth reconnect metadata. Successful structured results and their validation are unchanged.

## 6.1.3

Clarify that video summaries, lecture notes, and matching moments use analyze, while identified analyses/results are reused. Explain native ChatGPT file handoff at runtime before reporting an attachment limitation. Tool schemas, authorization, processing, and duplicate-submission safeguards are unchanged.

## 6.1.2

Correct the public-internet annotation for analyze and import_media in OAuth connections. Both tools accept public media URLs, so they remain open-world even when callbacks are unavailable. Input schemas and processing behavior are unchanged.

## 6.1.1

- Remove the retired multipart media uploader and its request types. Authorized local files use the existing native resumable storage flow across all six conversational tools.

## 6.1.0

- Analyze or import public HTTPS media and individual YouTube URLs using `source.urls` across hosted, OAuth, and local transports. The backend shares the existing durable import and analysis lifecycle.
- Preserve the six conversational tools, existing resumable local uploads, bounded concurrency, and observation behavior.

## 6.0.0

Breaking conversational-only release. Remove embedded Studio, picker, widget resources, six private app tools, and their build dependencies. The six public MCP tools return progress and results directly in the conversation.

Native ChatGPT attachments use root `files` descriptors with host-provided temporary HTTPS URLs; local stdio clients retain authorized `source.file_paths` uploads. New hosted submissions require actual media and fail before creating a job when it is missing. Published schemas expose typed root fields while preserving structured cloud configuration and filters; canonical validation retains all conditional requirements.

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
