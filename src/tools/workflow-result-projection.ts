import { DEFAULT_APP_ORIGIN } from './workflow-result-contract.js';

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
function workflowSource(toolName: 'analysis_results' | 'search_results', payload: RecordValue): { kind: ResultSourceKind; id: string } | undefined {
  const id = toolName === 'search_results' ? payload.search_id ?? payload.snapshot_id : payload.run_id;
  return typeof id === 'string' && id ? {kind: toolName === 'search_results' ? 'search_snapshot' : 'prompt_run', id} : undefined;
}

export function projectWorkflowPayload(toolName: 'analysis_results' | 'search_results', payload: RecordValue, detail: ResultDetail, origin = appOrigin()): RecordValue {
  payload = requireRecord(payload);
  const result: RecordValue = { contract_version: 2, detail, links: {}, artifacts: [] };
  const links = result.links as RecordValue;
  const budget: PreviewBudget = { remaining: 8192 };
  if (toolName === 'search_results') {
    Object.assign(result, fields(payload, ['mode', 'result_level', 'snapshot_id', 'search_id', 'captured_at', 'expires_at', 'results', 'next_action']));
    result.data = requireArray(payload.data).map(raw => {
      const row = rowProjection(raw, detail, undefined, 'all', origin, budget);
      if (toolName === 'search_results' && detail === 'summary') {
        row.analysis_id = row.run_id ?? row.prompt_run_id ?? row.source_run_id;
        for (const key of ['run_id', 'prompt_run_id', 'source_run_id']) delete row[key];
      }
      return row;
    });
    result.pagination = pagination(payload.pagination);
    if (payload.results != null) result.results = fields(requireRecord(payload.results), ['revision', 'included_results', 'requested_limit', 'final', 'download_url', 'expires_in_seconds'], Number.MAX_SAFE_INTEGER);
    if (payload.next_action != null) {
      const action = requireRecord(payload.next_action);
      result.next_action = { ...fields(action, ['type', 'cursor', 'after_seconds', 'message'], Number.MAX_SAFE_INTEGER),
        ...(action.analysis_ids === undefined ? {} : { analysis_ids: ids(action.analysis_ids) }) };
    }
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
      'text_searchable_results', 'image_searchable_results', 'text_not_applicable_results', 'image_not_applicable_results',
    ]);
    const pendingAnalysisIds = asRecord(payload.coverage).indexing_pending_analysis_ids;
    if (pendingAnalysisIds !== undefined) (result.coverage as RecordValue).indexing_pending_analysis_ids = ids(pendingAnalysisIds);
    result.warnings = Array.isArray(payload.warnings) ? payload.warnings.slice(0, 5).map(warning => typeof warning === 'string' ? warning.slice(0, 300) : fields(asRecord(warning), ['code', 'message'])) : [];
  } else if (toolName === 'analysis_results') {
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
  }
  const source = workflowSource(toolName, payload);
  if (source) {
    result.source_kind = source.kind;
    result.source_id = source.id;
    const destination = asRecord(payload.destination);
    const firstRow = [asRecord(payload.filtered).data, asRecord(payload.unfiltered).data].flatMap(value => Array.isArray(value) ? value : []).map(asRecord).find(row => row.video_id);
    const runContext = asRecord(payload.run_context ?? asRecord(payload.configuration).run_context);
    const videoId = firstRow?.video_id ?? payload.video_id ?? ids(payload.video_ids)[0] ?? ids(runContext.video_ids)[0];
    const playground = destination.type === 'playground' || runContext.is_playground === true;
    const indexId = playground ? undefined : destination.index_id ?? firstRow?.source_index_id ?? payload.target_index_id ?? runContext.index_id;
    links.open_in_app = source.kind === 'prompt_run' && videoId
      ? resultLink({ ...firstRow, video_id: videoId, index_id: undefined, source_index_id: indexId }, source.id, 'all', origin, false, !firstRow)
      : artifactLink(source.kind, source.id, source.kind === 'prompt_run' ? 'all' : 'search_results', undefined, origin);
  }
  if (toolName === 'search_results') {
    const scope = asRecord(payload.scope);
    const firstRow = requireArray(payload.data).map(asRecord).find(row => row.video_id);
    const container = scope.index_id ?? firstRow?.source_index_id ?? firstRow?.index_id;
    const indexId = container === 'playground' ? undefined : container;
    links.open_in_app = firstRow
      ? resultLink({ ...firstRow, index_id: undefined, source_index_id: indexId }, undefined, 'all', origin)
      : indexId ? link('/index', { index: indexId }, origin) : link('/playground', { step: 'studio' }, origin);
    if (detail === 'summary') {
      result.search_id = payload.search_id ?? payload.snapshot_id;
      for (const key of ['snapshot_id', 'source_id', 'source_kind']) delete result[key];
    }
  }
  return result;
}
