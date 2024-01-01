import type { TextContent } from '@modelcontextprotocol/sdk/types.js';

export interface OAuthProjectableToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  oauthAuthenticationFailure?: boolean;
  _meta?: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;
type PayloadProjector = (payload: JsonRecord) => JsonRecord;

const SEARCH_RESULT_IDENTITY_FIELDS = [
  'result_type',
  'result_id',
  'video_id',
  'video_name',
  'segment_id',
  'start_time',
  'end_time',
  'preview_segment_id',
  'preview_start_time',
  'preview_end_time',
  'duration',
] as const;

const SEARCH_RESULT_SCORE_FIELDS = [
  'score',
  'similarity_score',
  'reranked_score',
  'fused_score',
  'text_score',
  'image_score',
  'text_rank',
  'image_rank',
  'match_type',
  'matched_image_timestamp',
  'matched_image_score',
  'shot_timestamp',
  'field_scores',
  'field_instance_scores',
  'matched_field_paths',
  'matched_field_instances',
] as const;

const SEARCH_RESULT_CONTEXT_FIELDS = [
  'media_type',
  'run_id',
  'source_run_id',
  'prompt_run_id',
  'prompt_id',
  'source_index_id',
] as const;

class OAuthResultProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthResultProjectionError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new OAuthResultProjectionError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OAuthResultProjectionError(`${label} must be an array`);
  }
  return value;
}

function requireNonEmptyString(record: JsonRecord, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OAuthResultProjectionError(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function copyPresent(
  source: JsonRecord,
  target: JsonRecord,
  fields: readonly string[]
): void {
  for (const field of fields) {
    if (source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

function projectMarker(value: unknown): JsonRecord | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const marker = requireRecord(value, 'marker');
  const projected: JsonRecord = {};
  copyPresent(marker, projected, ['marker_id', 'color', 'note', 'updated_at']);
  return projected;
}

function projectMarkerMap(value: unknown): JsonRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const markers = requireRecord(value, 'metadata markers');
  const projected: JsonRecord = {};
  for (const [field, marker] of Object.entries(markers)) {
    projected[field] = projectMarker(marker) ?? null;
  }
  return projected;
}

function firstPresent(source: JsonRecord, fields: readonly string[]): unknown {
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      return source[field];
    }
  }
  return undefined;
}

function projectSearchResult(value: unknown, label: string): JsonRecord {
  const source = requireRecord(value, label);
  requireNonEmptyString(source, 'result_type', label);
  requireNonEmptyString(source, 'result_id', label);
  requireNonEmptyString(source, 'video_id', label);

  const projected: JsonRecord = {};
  copyPresent(source, projected, SEARCH_RESULT_IDENTITY_FIELDS);
  copyPresent(source, projected, SEARCH_RESULT_SCORE_FIELDS);
  copyPresent(source, projected, SEARCH_RESULT_CONTEXT_FIELDS);

  const content = firstPresent(source, [
    'content',
    'text_content',
    'content_preview',
    'metadata_text',
  ]);
  if (content !== undefined) {
    projected.content = content;
  }

  const metadata = firstPresent(source, ['metadata', 'extracted_metadata']);
  if (metadata !== undefined && metadata !== null) {
    projected.metadata = requireRecord(metadata, `${label}.metadata`);
  }

  const marker = projectMarker(source.marker);
  if (marker !== undefined) {
    projected.marker = marker;
  }
  const metadataMarkers = projectMarkerMap(
    source.extracted_metadata_markers ?? source.metadata_markers
  );
  if (metadataMarkers !== undefined) {
    projected.metadata_markers = metadataMarkers;
  }

  return projected;
}

function projectSearchResults(value: unknown, label: string): JsonRecord[] {
  return requireArray(value, label).map((item, index) =>
    projectSearchResult(item, `${label}[${index}]`)
  );
}

function projectSearchVideos(payload: JsonRecord): JsonRecord {
  requireNonEmptyString(payload, 'query', 'search_videos');
  requireNonEmptyString(payload, 'index_id', 'search_videos');
  const projected: JsonRecord = {};
  copyPresent(payload, projected, ['query', 'index_id', 'total_results']);
  const enrichment = requireRecord(payload.segment_enrichment, 'search_videos.segment_enrichment');
  projected.segment_enrichment = {
    resolved_results: enrichment.resolved_results,
    unresolved_results: enrichment.unresolved_results,
  };
  projected.results = projectSearchResults(payload.results, 'search_videos.results');
  return projected;
}

function projectWrappedSearch(
  payload: JsonRecord,
  label: string,
  wrapperFields: readonly string[]
): JsonRecord {
  requireNonEmptyString(payload, 'index_id', label);
  const projected: JsonRecord = {};
  copyPresent(payload, projected, wrapperFields);
  projected.results = projectSearchResults(payload.results, `${label}.results`);
  return projected;
}

function projectSegment(value: unknown, label: string): JsonRecord {
  const source = requireRecord(value, label);
  requireNonEmptyString(source, 'segment_id', label);
  requireNonEmptyString(source, 'video_id', label);
  const projected: JsonRecord = {};
  copyPresent(source, projected, [
    'segment_id',
    'video_id',
    'time_range',
    'start_time',
    'end_time',
    'duration',
    'processed',
    'processing_failed',
    'segment_status',
    'failure_stage',
    'failure_message',
    'metadata',
    'metadata_text',
    'from_run_id',
    'processing_warning',
  ]);

  const marker = projectMarker(source.marker);
  if (marker !== undefined) {
    projected.marker = marker;
  }
  const metadataMarkers = projectMarkerMap(source.metadata_markers);
  if (metadataMarkers !== undefined) {
    projected.metadata_markers = metadataMarkers;
  }
  if (isRecord(source.operations)) {
    const operations: JsonRecord = {};
    for (const name of ['field_extraction', 'transcription', 'image_embedding']) {
      const operation = source.operations[name];
      if (isRecord(operation) && operation.succeeded !== undefined) {
        operations[name] = { succeeded: operation.succeeded };
      }
    }
    if (Object.keys(operations).length > 0) {
      projected.operations = operations;
    }
  }
  return projected;
}

function projectVideoSegments(payload: JsonRecord): JsonRecord {
  requireNonEmptyString(payload, 'video_id', 'get_video_segments');
  const projected: JsonRecord = {};
  copyPresent(payload, projected, [
    'video_id',
    'run_id',
    'total_segments',
    'has_more',
  ]);
  projected.segments = requireArray(payload.segments, 'get_video_segments.segments').map(
    (segment, index) => projectSegment(segment, `get_video_segments.segments[${index}]`)
  );
  return projected;
}

function projectPromptRunVideoResult(payload: JsonRecord): JsonRecord {
  requireNonEmptyString(payload, 'result_type', 'get_prompt_run_video_result');
  requireNonEmptyString(payload, 'result_id', 'get_prompt_run_video_result');
  requireNonEmptyString(payload, 'run_id', 'get_prompt_run_video_result');
  requireNonEmptyString(payload, 'prompt_run_id', 'get_prompt_run_video_result');
  requireNonEmptyString(payload, 'video_id', 'get_prompt_run_video_result');

  const projected: JsonRecord = {};
  copyPresent(payload, projected, [
    'result_type',
    'result_id',
    'run_id',
    'prompt_id',
    'prompt_run_id',
    'video_id',
    'video_name',
    'source_index_id',
    'status',
    'metadata',
    'successful_segment_count',
    'failed_segment_count',
    'processing_warning',
    'error_message',
    'executed_at',
    'started_at',
    'completed_at',
    'preview_start_time',
    'preview_end_time',
  ]);
  const content = firstPresent(payload, ['metadata_text', 'text_content', 'content_preview']);
  if (content !== undefined) {
    projected.content = content;
  }
  const marker = projectMarker(payload.marker);
  if (marker !== undefined) {
    projected.marker = marker;
  }
  return projected;
}

function projectExportStatus(payload: JsonRecord): JsonRecord {
  requireNonEmptyString(payload, 'export_id', 'get_export_status');
  requireNonEmptyString(payload, 'status', 'get_export_status');
  const projected: JsonRecord = {};
  copyPresent(payload, projected, [
    'export_id',
    'export_type',
    'target_id',
    'status',
    'created_at',
    'available_at',
    'started_at',
    'completed_at',
    'updated_at',
    'download_url',
    'file_size_bytes',
    'error_message',
    'destination_type',
    'destination_connector_id',
    'destination_subpath',
    'destination_uri',
    'tip',
  ]);
  if (payload.links !== undefined) {
    const links = requireRecord(payload.links, 'get_export_status.links');
    const publicLinks: JsonRecord = {
      open_in_app: requireNonEmptyString(links, 'open_in_app', 'get_export_status.links'),
    };
    if (links.download_json !== undefined) {
      publicLinks.download_json = requireNonEmptyString(links, 'download_json', 'get_export_status.links');
    }
    projected.links = publicLinks;
  }
  return projected;
}

const PROJECTORS: Readonly<Record<string, PayloadProjector>> = {
  search_videos: projectSearchVideos,
  search_videos_by_image: (payload) =>
    projectWrappedSearch(payload, 'search_videos_by_image', [
      'index_id',
      'search_type',
      'total_results',
    ]),
  multimodal_search: (payload) =>
    projectWrappedSearch(payload, 'multimodal_search', [
      'index_id',
      'search_type',
      'text_query',
      'has_image',
      'text_weight',
      'image_weight',
      'total_results',
    ]),
  filter_videos: (payload) =>
    projectWrappedSearch(payload, 'filter_videos', [
      'index_id',
      'search_type',
      'conditions',
      'total_results',
      'has_more',
      'next_cursor',
    ]),
  get_video_segments: projectVideoSegments,
  get_prompt_run_video_result: projectPromptRunVideoResult,
  get_export_status: projectExportStatus,
};

function decodePayload(result: OAuthProjectableToolResult): JsonRecord {
  if (result.structuredContent !== undefined) {
    return requireRecord(result.structuredContent, 'structuredContent');
  }
  if (result.content.length !== 1 || result.content[0]?.type !== 'text') {
    throw new OAuthResultProjectionError('tool result must contain exactly one JSON text block');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch {
    throw new OAuthResultProjectionError('tool result text must be valid JSON');
  }
  return requireRecord(parsed, 'tool result');
}

function projectionFailure(): OAuthProjectableToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: true,
            code: 'oauth_result_projection_failed',
            message: 'The tool returned an invalid public response shape.',
            recoverable: true,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Project advanced/legacy OAuth results onto explicit public shapes. Shared
 * workflow results are projected before this boundary. API-key and
 * stdio callers bypass this function at the execution boundary. The projectors
 * intentionally preserve user-authored metadata as opaque values and never use
 * a recursive key blacklist.
 */
export function projectOAuthToolResult(
  toolName: string,
  result: OAuthProjectableToolResult
): OAuthProjectableToolResult {
  const projector = PROJECTORS[toolName];
  if (!projector) {
    return result;
  }

  try {
    const payload = decodePayload(result);
    if (result.isError === true && payload.error === true) {
      return result;
    }
    const projected = projector(payload);
    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(projected, null, 2) }],
      structuredContent: projected,
    };
  } catch {
    return projectionFailure();
  }
}
