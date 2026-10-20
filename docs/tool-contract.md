# Tool Contract

`artifacts/tool-contract.json` is the release artifact that describes the public MCP surface.

It includes:

- package name, version, and binary command
- server name and supported transports
- canonical environment variable names
- tool names, descriptions, input schemas, annotations, categories, required API scopes, and availability

Each tool's `availability.profiles` identifies whether it belongs to the
`simple` and/or `full` profile. `availability.transports` is authoritative for
hosting. `find` and `upload_media` support both transports, while their local
path shortcuts are removed from hosted input schemas. Consumers that build
hosted tool lists must apply that transport projection as well as availability.

Regenerate it after tool changes:

```bash
npm run generate:contract
```

CI runs:

```bash
npm run check:contract
```

Private VectorMethods services should vendor this artifact during release instead of hand-maintaining duplicate MCP tool schemas.

## Export status and capability example

Status polling is side-effect free. A completed direct export exposes only its
authenticated API endpoint:

```json
{
  "export_id": "exp_example",
  "status": "completed",
  "destination_type": "download",
  "destination_connector_id": null,
  "download_url": "/api/v2/exports/exp_example/download"
}
```

Only the separate `get_export_download_url` tool invokes the bearer-capability
mint endpoint. Its response has exactly five fields, and `download_url` remains
`null` whenever the export is not directly downloadable:

```json
{
  "export_id": "exp_example",
  "status": "completed",
  "destination_type": "download",
  "destination_connector_id": null,
  "download_url": "<short-lived bounded bearer URL>"
}
```

## Asynchronous execution and result pages

`find` accepts `instruction` and optional native `files`. Each file declares
`download_url`, `file_id`, optional `mime_type`, and optional `file_name`; only
the first two fields are required. `_meta["openai/fileParams"]` names the
`files` array. `upload_media` accepts the same files for advanced intake.
Omitted files create an `awaiting_upload` job and an inline MCP Apps picker.
Its upload grant is returned only in tool-result `_meta.upload`.

Both operations return `job_id`, `status`, `phase`, ordered `outputs`, `execution`, source/part `progress`, page-scoped `video_ids`, and nullable `run_id`. `get_import_job` accepts `limit` and `cursor` for output pagination.
Use `get_import_job` for ingestion and `get_prompt_run_status` once an execution
has been admitted. `retry_import_job` explicitly resumes a failed attachment
job using its uploaded files. A persisted wizard failure with a 4xx outcome
allows a new generation attempt while retaining the job and run identity.
Successful generation receipts are reused. An uncertain 5xx generation
outcome returns HTTP 409 instead of silently issuing another generation.
Keep the same retry idempotency key when replaying one retry request. A new
`find` command gets a new idempotency identity and execution.

`define_prompt` generates optional `selection_filter` conditions in the same
call as extraction schemas. Ordinary extraction requests produce no selection
filter. The saved prompt carries both its filter and execution defaults.

Video and audio support `content_aware` (the default) and `fixed` segmentation.
`create_prompt` and `update_prompt` save these engine settings inside
`execution_config`; `process_media` and `estimate_prompt_run` accept top-level
overrides. Null or omitted run overrides inherit engine settings. Fixed mode
requires the corresponding duration in integer seconds from 1 to 300.
Generated prompt instructions preserve supported segmentation intent qualitatively.
Content-aware video/audio use chronological coverage and 10-second to 15-minute
prompt guidance without enforcing those output durations.

Start work with `process_media`; retain its `run_id` and poll
`get_prompt_run_status`. These tools and `get_prompt_run_results` are available
in both profiles. `execute_prompt` has been removed from the MCP tool surface.

`get_prompt_run_results` accepts `run_id`, `result_level` (`segment` by default,
or `video`), optional `video_id`, `view` (`both` by default), `limit` (10 by
default, at most 50), `filtered_cursor`, and `unfiltered_cursor`. It returns
`filtered` and `unfiltered` pages, each with `data` and
`pagination: {limit, has_more, next_cursor}`. Pass a cursor with its matching
view to advance one stream without rereading the other. Cursors are scoped to
the run, result level, media selection, and view.

`selection_summary.status` distinguishes `not_applicable`, `pending`, `ready`,
and `failed`. A ready empty filtered page means no matches. A null page is not
requested or not available; selection failure does not discard extraction.
Default pages contain compact metadata and media/segment identities, without embedding
raw model responses, repeated metadata text, or storage capabilities. Reads do
not rerun generation, extraction, or search.

## Workflow results version 2

All nine workflow tools return `contract_version: 2`, a `detail` value, `links`,
and `artifacts`, identically in JSON text and `structuredContent`. This applies
to both profiles, transports, and authentication methods. Summary is the default:
rows include identity, timing, metadata previews, field counts, omission flags, and app links;
previews use at most 512 characters per row and a shared 8 KiB UTF-8 budget per response.
full extracted metadata stays outside model context. `detail: "full"` opts into
metadata or prompt details on `define_prompt`, `process_media`,
`get_prompt_run_status`, `get_prompt_run_results`, and `search_media`. It does
not change page size, cursors, backend requests, or idempotency identity. Full
mode preserves complete canonical public result fields on the requested page;
storage locators and media capabilities remain excluded.

Result links use `output=video|segment` to select metadata output and the separate
`playback=video|segment` parameter to select the existing player mode. A whole-video
watch link needs no whole-video extraction output or preview segment identity.

MCP requests automatic JSON delivery when starting `find`, `process_media`,
or a new `search_media`; following a search cursor reads its saved snapshot.
Artifact scopes are `all` and `matches` for runs, or `search_results` for a
search snapshot. Their explicit delivery states distinguish waiting, preparing,
ready, failed, unavailable, and not applicable. Artifact `href` values point to
the authenticated app export view, never storage grants or raw API routes.
Search results retain the backend `snapshot_id` and `expires_at`.

Only `get_prompt_run_results` and `search_media` attach the optional results
card. Its app-only helpers include: `view_workflow_results` reads
existing pages into `_meta.view`; `play_workflow_media` requests an authorized
ID-based playback grant into `_meta.media`. Neither helper is part of the nine
model-facing workflow tools. MCP Apps hosts that honor app visibility and private
tool metadata keep card inspection data outside model context. Download controls
open the app's authenticated export view. The card shares its base theme and
control styling with the attachment picker; optional view controls stay collapsed.
Hosts without MCP Apps use the same summaries and app links.

`MCP_APP_BASE_URL` configures the HTTPS app origin and defaults to
`https://app.vectormethods.com`. URLs cannot contain credentials, a path, query,
or fragment. A user's MCP OAuth connection does not automatically sign their
browser into the app; browser links use the normal app login flow.

For remote OpenAI clients, use the existing OAuth-enabled Streamable HTTP
transport. Work remains in the backend between calls; no transport session or
long-held tool call is needed to wait for completion. Structured tool output
and text content describe the same result.

## Studio search

`search_media` accepts a semantic `query`, conditional `filters`, or both. Combined conditions filter the ranked semantic window of up to 100 candidates. `video_ids` includes all searchable executions containing those videos; `prompt_run_ids` retains its explicit execution scope. Cursor reads never rerun search.

The embedded Studio uses app-only `list_studio_scope` and `get_studio_previews` read adapters. Catalogs and preview grants are returned in private `_meta`; preview grants are acquired only for visible media through the shared frontend cache. Result and playback reads keep their existing authorization boundaries.

For example, an agent can search selected Playground videos and apply a metadata condition in the same request:

```json
{
  "name": "search_media",
  "arguments": {
    "video_ids": ["video-1", "video-2"],
    "query": "person entering a car",
    "filters": [{ "field": "vehicle.color", "operator": "equals", "value": "red" }],
    "result_level": "segment",
    "limit": 50,
    "idempotency_key": "selected-videos-car-search-1"
  }
}
```

Use a real field from the execution schema. Omit `query` for a conditional-only search; omit `filters` for semantic-only search. Reuse the same idempotency key when retrying an uncertain request. Replace `video_ids` with `prompt_run_ids` to search an explicit execution; selectors are mutually exclusive. Follow the returned cursor with a `search_media` request containing only `cursor` and the desired page limit.

## Standalone parts and grounded extraction

Uploads return durable import jobs. Long videos become the minimum number of
balanced standalone parts, each at most 40 minutes. Each part has its own media
ID, local timestamps, segments and optional whole-media output. Job phase and
source-file counters are separate from `parts_total`, `parts_completed`, and
`parts_failed`. Read every ordered outputs page (`next_cursor` until null).
`video_ids` includes only the current page. Use `import_job_id` with processing
to select the complete completed import, exclusive with `video_ids`.

The optional `video_level` configuration contains only `instructions_text` and
`json_schema`. It requires content-aware segmentation. Segment and whole-media
fields are returned in the same media call, grounded directly in the supplied
part; there is no later segment-text synthesis or cross-part summary.

Failed-source details are paginated independently: pass `failed_files_next_cursor` as `failed_files_cursor` to `get_import_job` until null before refreshing descriptors and retrying.
