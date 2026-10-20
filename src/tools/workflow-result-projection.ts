import type { VideoVectorClient } from '../client/index.js';
import type { ToolHandlerResult } from './index.js';
import { DEFAULT_APP_ORIGIN } from './workflow-result-contract.js';
import { addWorkflowPreviewReferences } from './workflow-result-previews.js';

type RecordValue = Record<string, unknown>;
export type ResultDetail = 'summary' | 'full';
export type ResultSourceKind = 'prompt_run' | 'search_snapshot';

export function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function requireRecord(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public result object');
  return value as RecordValue;
}
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid public result array');
  return value;
}
function requireIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid public result identity');
  return value;
}
function fields(source: RecordValue, names: readonly string[], limit = 240): RecordValue {
  const result: RecordValue = {};
  for (const name of names) {
    const value = source[name];
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[name] = value;
    else if (typeof value === 'string') result[name] = name.endsWith('_id') ? value : value.slice(0, limit);
  }
  return result;
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
}

export function appOrigin(configured = process.env.MCP_APP_BASE_URL ?? DEFAULT_APP_ORIGIN): string {
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('MCP_APP_BASE_URL must be an HTTPS origin');
  }
  return url.origin;
}
function link(path: string, params: Record<string, unknown>, origin: string): string {
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' && value || typeof value === 'number' && Number.isFinite(value)) url.searchParams.set(name, String(value));
  }
  return url.href;
}

export function resultLink(row: RecordValue, runId: unknown, scope: 'all' | 'matches', origin: string, json = false, wholeVideo = false): string {
  const sourceIndexId = row.source_index_id ?? row.index_id;
  const indexId = sourceIndexId === 'playground' ? undefined : sourceIndexId;
  const videoLevel = row.result_type === 'video' || (!row.segment_id && !row.preview_segment_id);
  return link(indexId ? '/index' : '/playground', {
    ...(indexId ? { index: indexId, view: 'video' } : { step: 'studio' }),
    video: row.video_id, run: row.run_id ?? row.prompt_run_id ?? row.source_run_id ?? runId,
    result: scope, segment: wholeVideo || videoLevel ? undefined : row.segment_id ?? row.preview_segment_id,
    output: wholeVideo ? undefined : videoLevel ? 'video' : 'segment',
    playback: wholeVideo ? 'video' : undefined,
    metadata: json ? 'json' : 'fields', t: wholeVideo || videoLevel ? undefined : row.start_time ?? row.preview_start_time,
  }, origin);
}
export function artifactLink(kind: ResultSourceKind | undefined, sourceId: string | undefined, scope: string, exportId: unknown, origin: string, download = false): string {
  return link('/jobs', { tab: 'exports', export: exportId, source_kind: kind, source_id: sourceId, scope, action: download ? 'download' : undefined }, origin);
}

const ROW_FIELDS = [
  'result_id', 'result_type', 'video_id', 'video_name', 'segment_id', 'run_id', 'prompt_run_id',
  'source_run_id', 'source_index_id', 'media_type', 'start_time', 'end_time', 'preview_segment_id',
  'preview_start_time', 'preview_end_time', 'duration', 'status', 'embedding_status', 'video_matched',
  'field_extraction_succeeded', 'matched_segment_count', 'score', 'similarity_score', 'reranked_score',
] as const;
// Canonical public result fields only. Storage locators, encoded media and
// transport capabilities never become model-visible, even in explicit full mode.
const FULL_ROW_FIELDS = [...ROW_FIELDS,
  'prompt_id', 'executed_at', 'content', 'text_content', 'content_preview', 'metadata_text',
  'raw_llm_response', 'processing_warning', 'schema_used', 'transcription_succeeded',
  'image_embedding_succeeded', 'field_extraction_error', 'transcription_error',
  'image_embedding_error', 'successful_segment_count', 'failed_segment_count',
  'failure_stage', 'failure_message',
  'error_message', 'started_at', 'completed_at',
  'fused_score', 'text_score', 'image_score', 'text_rank', 'image_rank', 'match_type',
  'matched_image_timestamp', 'matched_image_score', 'shot_timestamp', 'field_scores',
  'field_instance_scores', 'matched_field_paths', 'matched_field_instances',
] as const;
type PreviewBudget = { remaining: number };
function preview(value: string, maxChars: number, budget: PreviewBudget): string {
  let result = '';
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (result.length + character.length > maxChars || bytes > budget.remaining) break;
    result += character;
    budget.remaining -= bytes;
  }
  return result;
}
const STATUS_FIELDS = [
  'run_id', 'prompt_id', 'status', 'prompt_name', 'prompt_type', 'total_videos', 'completed_videos',
  'failed_videos', 'partial_videos', 'cancelled_videos', 'total_audios', 'completed_audios',
  'failed_audios', 'total_images', 'completed_images', 'failed_images', 'total_segments',
  'completed_segments', 'billing_status', 'billing_estimated_mt', 'billing_actual_mt',
  'video_level_enabled', 'video_level_total_items', 'video_level_completed_items', 'video_level_failed_items',
  'executed_at',
] as const;
function publicBillingError(value: unknown, status: unknown): string | null {
  if (value == null || value === '') return null;
  // Settlement workers persist str(exception), not a reviewed public message.
  // As with the tool error formatter, use public state to describe the action
  // without reflecting provider diagnostics, reservation IDs, or capabilities.
  if (status === 'pending_confirmation') return 'Billing confirmation is pending. Open this run in the app to review billing before starting another run.';
  if (status === 'pending_release') return 'Billing release is pending. Open this run in the app to review the reserved credits.';
  return 'Billing settlement requires attention. Open this run in the app to review billing.';
}

const IMPORT_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  validation_source_changed: 'The source file changed during import. Retry with the current file.',
  resource_import_destination_conflict: 'An import for this file already exists. Open the job to review its status before retrying.',
  resource_quota_exceeded: 'The account resource quota has been reached. Review account limits before retrying.',
  authorization_denied: 'The account cannot access the source file. Check connector access before retrying.',
  timeout_error: 'The source did not respond in time. Retry the failed import.',
  network_error: 'The source is temporarily unreachable. Retry the failed import.',
  attachment_refresh_required: 'The attachment link expired or is inaccessible. Supply a fresh descriptor for this file ID when retrying.',
  attachment_download_http_error: 'The attachment server returned an error. Review the HTTP status before retrying.',
  attachment_download_interrupted: 'The attachment transfer was interrupted. Retry this unfinished file.',
  attachment_download_incomplete: 'The attachment download was incomplete. Retry with an accessible attachment.',
  attachment_too_large: 'The attachment exceeds the per-file size limit.',
  upload_source_error: 'The selected upload source could not be read. Provide a fresh attachment.',
};
const IMPORT_SKIP_MESSAGES: Readonly<Record<string, string>> = {
  too_large: 'The file exceeds the per-file size limit. Use a smaller file.',
  unsupported_format: 'The file format is unsupported. Use a supported media format.',
  duplicate: 'The file was already imported or is being imported. Open the job to review it.',
};
function importFileName(value: unknown, position: number): string {
  if (typeof value !== 'string') return `File ${position + 1}`;
  // Preserve a useful file label, never a provider bucket, local directory,
  // URL authority, or the query/fragment holding a download capability.
  let path = value;
  try { path = decodeURIComponent(path); } catch { /* A literal percent is valid in a filename. */ }
  path = path.replace(/\\/g, '/');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { return `File ${position + 1}`; }
    try { path = decodeURIComponent(path); } catch { /* Keep malformed escapes as a literal label. */ }
  }
  path = path.split(/[?#]/, 1)[0] ?? '';
  const name = path.split('/').filter(Boolean).at(-1)?.replace(/\p{Cc}/gu, '').slice(0, 160);
  return name || `File ${position + 1}`;
}
function importFileIssues(payload: RecordValue, kind: 'failed' | 'skipped'): RecordValue {
  const key = `${kind}_files`;
  const raw = payload[key] === undefined ? [] : requireArray(payload[key]);
  const counts = [payload[`${key}_count`], asRecord(payload.progress)[kind]];
  const total = Math.max(raw.length, ...counts.map(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0));
  const records = raw.slice(0, 100).map((value, position) => {
    const source = requireRecord(value);
    const record: RecordValue = { path: importFileName(source.file_name ?? source.path, position) };
    for (const id of ['file_id', 'video_id']) {
      const value = source[id];
      if (typeof value === 'string' && (/^[\w.:-]{1,512}$/.test(value) || (id === 'file_id' && /^sediment:\/\/file_[a-zA-Z0-9_-]{1,128}$/.test(value)))) record[id] = value;
    }
    if (kind === 'skipped') {
      const reason = typeof source.reason === 'string' && Object.hasOwn(IMPORT_SKIP_MESSAGES, source.reason) ? source.reason : 'not_imported';
      record.reason = reason;
      record.message = IMPORT_SKIP_MESSAGES[reason] ?? 'The file was skipped. Open the job to review this file.';
    } else {
      const code = source.error_code ?? source.code;
      const category = typeof code === 'string' && Object.hasOwn(IMPORT_FAILURE_MESSAGES, code) ? code : undefined;
      if (typeof source.refresh_required === 'boolean') record.refresh_required = source.refresh_required;
      if (typeof source.http_status === 'number' && Number.isInteger(source.http_status) && source.http_status >= 400 && source.http_status <= 599) record.http_status = source.http_status;
      record.error_code = category ?? 'import_failed';
      record.error = category ? IMPORT_FAILURE_MESSAGES[category] : 'Import failed. Open the job to review this file before retrying the failed import.';
    }
    return record;
  });
  return { [key]: records, [`${key}_count`]: total, [`${key}_omitted_count`]: total - records.length,
    ...(kind === 'failed' && (payload.failed_files_next_cursor === null || typeof payload.failed_files_next_cursor === 'string') ? { failed_files_next_cursor: payload.failed_files_next_cursor } : {}),
  };
}
const CONFIGURATION_FIELDS = [
  'video_segmentation_type', 'audio_segmentation_type', 'image_segmentation_type',
  'video_segment_duration', 'audio_segment_duration', 'processing_model',
  'enable_transcription', 'enable_image_embedding', 'video_level_enabled',
] as const;

function runConfiguration(value: unknown): RecordValue {
  const raw = requireRecord(value);
  const result = fields(raw, CONFIGURATION_FIELDS, Number.MAX_SAFE_INTEGER);
  // The context is used below to derive exact navigation. Mutable checkpoints,
  // extraction provenance, and admission identities are never public settings.
  if (raw.run_context != null) {
    const context = requireRecord(raw.run_context);
    const publicContext = fields(context, ['is_playground']);
    if (context.video_ids !== undefined) publicContext.video_ids = ids(context.video_ids);
    if (context.is_playground !== true && typeof context.index_id === 'string') publicContext.index_id = context.index_id;
    result.run_context = publicContext;
  }
  return result;
}
function namedRecords(value: unknown, names: string[], keys: string[]): RecordValue {
  const raw = requireRecord(value);
  return Object.fromEntries(names.filter(name => raw[name] != null).map(name => [name, fields(requireRecord(raw[name]), keys)]));
}

function rowProjection(value: unknown, detail: ResultDetail, runId: unknown, scope: 'all' | 'matches', origin: string, budget: PreviewBudget): RecordValue {
  const raw = requireRecord(value);
  requireIdentity(raw.result_id);
  requireIdentity(raw.video_id);
  requireIdentity(raw.run_id ?? raw.prompt_run_id ?? raw.source_run_id ?? runId);
  const row = fields(raw, ROW_FIELDS);
  if (typeof raw.embedding_error === 'string' && raw.embedding_error.trim()) row.embedding_error = 'Search indexing failed. Retry indexing using a canonical segment after the run finishes.';
  const metadata = raw.metadata ?? raw.extracted_metadata;
  if (detail === 'full') {
    for (const key of FULL_ROW_FIELDS) if (raw[key] !== undefined) row[key] = raw[key];
    if (metadata != null) row.metadata = requireRecord(metadata);
    for (const key of ['marker', 'metadata_markers', 'extracted_metadata_markers']) {
      if (raw[key] == null) continue;
      const marker = (value: unknown): RecordValue => fields(asRecord(value), ['marker_id', 'color', 'note', 'updated_at'], Number.MAX_SAFE_INTEGER);
      row[key] = key === 'marker' ? marker(raw[key]) : Object.fromEntries(Object.entries(asRecord(raw[key])).map(([name, value]) => [name, marker(value)]));
    }
    // Normalize the main content alias without preferring a shorter preview.
    const content = raw.content ?? raw.text_content ?? raw.metadata_text ?? raw.content_preview;
    if (content !== undefined) row.content = content;
  } else {
    if (metadata != null) {
      requireRecord(metadata);
      const names = Object.keys(metadata);
      row.metadata_fields = names.slice(0, 20).map(name => name.slice(0, 80));
      row.metadata_field_count = names.length;
      row.metadata_fields_omitted = Math.max(0, names.length - 20);
      const serialized = JSON.stringify(metadata);
      const metadataPreview = preview(serialized, 512, budget);
      row.metadata_preview = metadataPreview;
      row.metadata_omitted = serialized.length > metadataPreview.length;
    }
    const original = raw.content ?? raw.text_content ?? raw.metadata_text ?? raw.content_preview;
    const content = typeof original === 'string' ? preview(original, 240, budget) : undefined;
    if (content) row.content = content;
    if (typeof original === 'string') row.content_omitted = original.length > (content?.length ?? 0);
  }
  if (row.video_id) row.links = {
    play: resultLink(row, runId, scope, origin),
    json: resultLink(row, runId, scope, origin, true),
    watch_video: resultLink(row, runId, scope, origin, false, true),
  };
  return row;
}
function pagination(value: unknown): RecordValue {
  // Cursors must remain byte-for-byte intact; truncating one strands the next page.
  const raw = requireRecord(value);
  const result = fields(raw, ['limit', 'count', 'has_more', 'result_window', 'truncated']);
  if (raw.next_cursor === null || typeof raw.next_cursor === 'string') result.next_cursor = raw.next_cursor;
  return result;
}
function page(value: unknown, detail: ResultDetail, runId: unknown, scope: 'all' | 'matches', origin: string, budget: PreviewBudget): RecordValue | null {
  if (value === null) return null;
  const raw = requireRecord(value);
  return {
    data: requireArray(raw.data).map(row => rowProjection(row, detail, runId, scope, origin, budget)),
    pagination: pagination(raw.pagination),
  };
}
function selection(value: unknown): RecordValue {
  return fields(asRecord(value), [
    'status', 'state', 'total_segments', 'matched_segments', 'unmatched_segments', 'pending_segments',
    'failed_segments', 'total_videos', 'matched_videos', 'unmatched_videos', 'pending_videos',
    'failed_videos', 'evaluated_segments', 'evaluated_videos', 'error_message', 'reason',
    'selected_media_count', 'selected_video_count', 'selected_segment_count',
  ]);
}
function prompt(value: unknown, detail: ResultDetail): RecordValue {
  const raw = requireRecord(value);
  const result = fields(raw, ['prompt_id', 'name', 'description', 'prompt_type', 'is_active'], detail === 'full' ? Number.MAX_SAFE_INTEGER : 240);
  if (detail === 'full') {
    Object.assign(result, fields(raw, ['created_at'], Number.MAX_SAFE_INTEGER));
    for (const key of ['prompt_text', 'json_schema', 'video_level', 'semantic_indexing', 'execution_config', 'selection_filter']) {
      if (raw[key] !== undefined) result[key] = raw[key];
    }
  } else {
    const properties = asRecord(asRecord(raw.json_schema).properties);
    result.metadata_fields = Object.keys(properties).slice(0, 20).map(name => name.slice(0, 80));
  }
  return result;
}

export function workflowSource(toolName: string, payload: RecordValue): { kind: ResultSourceKind; id: string } | undefined {
  if (toolName === 'search_media') {
    const id = payload.snapshot_id;
    return typeof id === 'string' && id ? { kind: 'search_snapshot', id } : undefined;
  }
  const id = payload.run_id ?? asRecord(payload.run).run_id;
  return typeof id === 'string' && id ? { kind: 'prompt_run', id } : undefined;
}

export function projectWorkflowPayload(toolName: string, payload: RecordValue, detail: ResultDetail, origin = appOrigin()): RecordValue {
  payload = requireRecord(payload);
  const result: RecordValue = { contract_version: 2, detail, links: {}, artifacts: [] };
  const links = result.links as RecordValue;
  const budget: PreviewBudget = { remaining: 8192 };
  const run = toolName === 'process_media' ? requireRecord(payload.run) : payload;
  if (['process_media', 'get_prompt_run_status'].includes(toolName)) {
    requireIdentity(payload.run_id);
    Object.assign(result, fields(run, STATUS_FIELDS, detail === 'full' ? Number.MAX_SAFE_INTEGER : 240));
    if (run.billing_error !== undefined) result.billing_error = publicBillingError(run.billing_error, run.billing_status);
    if (run.error_message !== undefined) result.error_message = run.error_message == null || run.error_message === ''
      ? null : 'This run needs attention. Open the run in the app to review its status before retrying.';
    if (payload.run_id) result.run_id = payload.run_id;
    if (run.selection_summary) result.selection_summary = selection(run.selection_summary);
    if (run.progress) result.progress = fields(asRecord(run.progress), ['total_media', 'completed', 'failed', 'partial', 'cancelled', 'percent', 'total_segments', 'completed_segments']);
    if (run.video_level) result.video_level = fields(asRecord(run.video_level), ['enabled', 'total_items', 'completed_items', 'failed_items', 'partial_items']);
    if (detail === 'full') {
      if (run.selection_filter !== undefined) result.selection_filter = run.selection_filter === null ? null : requireRecord(run.selection_filter);
      if (run.execution_config !== undefined) result.execution_config = run.execution_config === null ? null : fields(requireRecord(run.execution_config), CONFIGURATION_FIELDS, Number.MAX_SAFE_INTEGER);
      if (run.reuse_summary != null) result.reuse_summary = fields(requireRecord(run.reuse_summary), ['target_media_count', 'reused_media_count', 'fresh_media_count']);
      // Process responses carry settings directly on run; status responses use
      // the existing formatter's configuration object.
      result.configuration = runConfiguration(run.configuration ?? run);
      if (run.media_breakdown != null) result.media_breakdown = namedRecords(run.media_breakdown, ['videos', 'audios', 'images'], ['total', 'completed', 'failed', 'partial', 'cancelled']);
      if (run.operations != null) result.operations = namedRecords(run.operations, ['field_extraction', 'transcription', 'image_embedding'], ['enabled', 'succeeded', 'failures']);
    }
    if (toolName === 'process_media') {
      if (typeof payload.prompt_created_inline === 'boolean') result.prompt_created_inline = payload.prompt_created_inline;
      if (payload.prompt !== undefined) result.prompt = payload.prompt === null ? null : prompt(payload.prompt, detail);
    }
  } else if (toolName === 'define_prompt') {
    if (payload.prompt_id == null && !['prompt', 'draft', 'definition'].some(key => payload[key] != null)) throw new Error('Invalid public prompt response');
    Object.assign(result, fields(payload, ['prompt_id', 'saved']));
    for (const key of ['prompt', 'draft', 'definition']) if (payload[key] !== undefined) result[key] = payload[key] === null ? null : prompt(payload[key], detail);
  } else if (toolName === 'search_media') {
    Object.assign(result, fields(payload, ['mode', 'result_level', 'snapshot_id', 'captured_at', 'expires_at']));
    result.data = requireArray(payload.data).map(row => rowProjection(row, detail, undefined, 'all', origin, budget));
    result.pagination = pagination(payload.pagination);
    if (payload.scope != null) {
      const sourceScope = requireRecord(payload.scope);
      result.scope = {
        ...fields(sourceScope, ['type', 'index_id']),
        ...(sourceScope.video_ids === undefined ? {} : { video_ids: ids(sourceScope.video_ids) }),
        ...(sourceScope.prompt_run_ids === undefined ? {} : { prompt_run_ids: ids(sourceScope.prompt_run_ids) }),
      };
    }
    result.coverage = fields(asRecord(payload.coverage), [
      'prompt_run_count', 'searchable_video_count', 'partial_prompt_run_count', 'requested_video_count', 'covered_video_count',
      'status', 'complete', 'searched_videos', 'total_videos', 'searchable_videos', 'excluded_videos', 'missing_videos',
    ]);
    result.warnings = Array.isArray(payload.warnings) ? payload.warnings.slice(0, 5).map(warning => typeof warning === 'string' ? warning.slice(0, 300) : fields(asRecord(warning), ['code', 'message'])) : [];
  } else if (toolName === 'get_prompt_run_results') {
    requireIdentity(payload.run_id);
    Object.assign(result, fields(payload, ['run_id', 'status', 'result_level']));
    result.selection_summary = selection(payload.selection_summary);
    if (detail === 'full' && payload.selection_filter !== undefined) result.selection_filter = payload.selection_filter;
    const destination = fields(asRecord(payload.destination), ['type', 'index_id']);
    const withDestination = (value: unknown): unknown => {
      if ((!destination.index_id && destination.type !== 'playground') || value == null) return value;
      const rawPage = asRecord(value);
      return { ...rawPage, data: requireArray(rawPage.data).map(row => ({ ...requireRecord(row), index_id: undefined, source_index_id: destination.type === 'playground' ? undefined : destination.index_id })) };
    };
    result.destination = destination;
    result.filtered = page(withDestination(payload.filtered), detail, payload.run_id, 'matches', origin, budget);
    result.unfiltered = page(withDestination(payload.unfiltered), detail, payload.run_id, 'all', origin, budget);
  } else {
    requireIdentity(payload.job_id);
    requireIdentity(payload.status);
    Object.assign(result, fields(payload, ['job_id', 'status', 'phase', 'run_id', 'source_kind', 'target_index_id']));
    if (payload.error_message !== undefined) result.error_message = payload.error_message == null || payload.error_message === ''
      ? null : 'This import job needs attention. Open the job in the app to review the failed or skipped files before retrying.';
    result.video_ids = ids(payload.video_ids);
    if (payload.outputs !== undefined) {
      const outputs = requireRecord(payload.outputs);
      result.outputs = {
        items: requireArray(outputs.items).map((item) => fields(requireRecord(item), ['file_id', 'file_name', 'source_ordinal', 'part_index', 'part_count', 'source_start_seconds', 'source_end_seconds', 'video_id', 'title', 'status'], Number.MAX_SAFE_INTEGER)),
        next_cursor: outputs.next_cursor,
        total: outputs.total,
      };
    }
    if (payload.execution !== undefined) {
      const execution = requireRecord(payload.execution);
      result.execution = fields(execution, ['status', 'run_id', 'error_code']);
      if (execution.error != null) (result.execution as RecordValue).error = 'Processing was not admitted. Open the import job to review the error and retry.';
    }

    result.progress = fields(asRecord(payload.progress), ['total_files', 'imported', 'failed', 'skipped', 'percent', 'bytes_transferred', 'parts_total', 'parts_completed', 'parts_failed']);
    Object.assign(result, importFileIssues(payload, 'failed'), importFileIssues(payload, 'skipped'));
    if (payload.job_id) {
      links.import_job = link('/jobs', { tab: 'imports', job: payload.job_id }, origin);
      links.open_in_app = links.import_job;
    }
    const videoId = ids(payload.video_ids)[0];
    if (videoId) links.watch_video = resultLink({ video_id: videoId, source_index_id: payload.target_index_id }, payload.run_id, 'all', origin, false, true);
  }
  const source = workflowSource(toolName, payload);
  if (source) {
    result.source_kind = source.kind;
    result.source_id = source.id;
    const destination = asRecord(payload.destination);
    const firstRow = [asRecord(payload.filtered).data, asRecord(payload.unfiltered).data].flatMap(value => Array.isArray(value) ? value : []).map(asRecord).find(row => row.video_id);
    const runContext = asRecord(run.run_context ?? asRecord(run.configuration).run_context);
    const videoId = firstRow?.video_id ?? payload.video_id ?? ids(payload.video_ids)[0] ?? ids(runContext.video_ids)[0];
    const playground = destination.type === 'playground' || runContext.is_playground === true;
    const indexId = playground ? undefined : destination.index_id ?? firstRow?.source_index_id ?? payload.target_index_id ?? runContext.index_id;
    links.open_in_app = source.kind === 'prompt_run' && videoId
      ? resultLink({ ...firstRow, video_id: videoId, index_id: undefined, source_index_id: indexId }, source.id, 'all', origin, false, !firstRow)
      : artifactLink(source.kind, source.id, source.kind === 'prompt_run' ? 'all' : 'search_results', undefined, origin);
  }
  return result;
}

export async function addWorkflowArtifacts(payload: RecordValue, source: ReturnType<typeof workflowSource>, client: VideoVectorClient, origin = appOrigin()): Promise<void> {
  if (!source) return;
  const validScopes = source.kind === 'prompt_run' ? ['all', 'matches'] : ['search_results'];
  let rawArtifacts: unknown[];
  try {
    const delivery = await client.workflowDelivery(source.kind, source.id);
    rawArtifacts = Array.isArray(delivery.artifacts) ? delivery.artifacts : validScopes.map(scope => ({ scope, state: 'unavailable', error_code: 'invalid_delivery_response' }));
  } catch {
    rawArtifacts = validScopes.map(scope => ({ scope, state: 'unavailable', error_code: 'delivery_lookup_failed' }));
  }
  const states = new Set(['waiting_for_source', 'pending', 'preparing', 'ready', 'failed', 'not_applicable', 'unavailable']);
  payload.artifacts = rawArtifacts.slice(0, 3).flatMap(value => {
    const raw = asRecord(value);
    if (!validScopes.includes(String(raw.scope)) || !states.has(String(raw.state))) return [];
    return [{ ...fields(raw, ['scope', 'state', 'export_id', 'captured_at', 'error_code', 'error_message']), format_version: 2,
      href: artifactLink(source.kind, source.id, String(raw.scope), raw.export_id, origin) }];
  });
}

export async function projectWorkflowResult(toolName: string, raw: ToolHandlerResult, detail: ResultDetail, client: VideoVectorClient): Promise<ToolHandlerResult> {
  if (raw.isError) return raw;
  try {
    if (raw.structuredContent === undefined && (raw.content.length !== 1 || raw.content[0]?.type !== 'text')) throw new Error('Invalid public result content');
    const payload = requireRecord(raw.structuredContent ?? JSON.parse(raw.content[0]!.text));
    const projected = projectWorkflowPayload(toolName, payload, detail);
    await addWorkflowArtifacts(projected, workflowSource(toolName, payload), client);
    const view = ['get_prompt_run_results', 'search_media'].includes(toolName)
      ? { ...projectWorkflowPayload(toolName, payload, 'full'), artifacts: projected.artifacts }
      : undefined;
    if (view) addWorkflowPreviewReferences(view, payload);
    return {
      ...raw,
      content: [{ type: 'text', text: JSON.stringify(projected) }],
      structuredContent: projected,
      ...(view ? { _meta: { ...raw._meta, view } } : {}),
    };
  } catch {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: true, code: 'workflow_result_projection_failed',
      message: 'The tool returned an invalid public response shape.', recoverable: true,
    }) }] };
  }
}
