import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const WORKFLOW_RESULT_TOOLS = new Set(['analyze', 'get_analysis', 'search', 'import_media', 'save_prompt', 'browse']);
export const WORKFLOW_DETAIL_TOOLS = new Set(WORKFLOW_RESULT_TOOLS);
export const RESULTS_CARD_URI = 'ui://videovector/results-card-v2.html';
export const RESULTS_VIEW_TOOL = 'view_workflow_results';
export const RESULTS_MEDIA_TOOL = 'play_workflow_media';
export const RESULTS_ARTIFACT_TOOL = 'download_workflow_artifact';
export const STUDIO_SCOPE_TOOL = 'list_studio_scope';
export const STUDIO_PREVIEWS_TOOL = 'get_studio_previews';
export const ANALYSIS_VIEW_TOOL = 'read_analysis';
export const RESULTS_APP_TOOLS = new Set([RESULTS_VIEW_TOOL, RESULTS_MEDIA_TOOL, RESULTS_ARTIFACT_TOOL, STUDIO_SCOPE_TOOL, STUDIO_PREVIEWS_TOOL, ANALYSIS_VIEW_TOOL]);
export const DEFAULT_APP_ORIGIN = 'https://app.vectormethods.com';

export const ANALYSIS_RESULT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  required: ['analysis_id', 'status', 'stage', 'message', 'progress', 'results', 'next_action'],
  properties: {
    analysis_id: { type: 'string' }, status: { type: 'string' }, stage: { type: 'string' }, message: { type: 'string' },
    scope: { type: 'object' }, progress: { type: 'object' },
    results: { type: 'object', properties: {
      included_videos: { type: 'integer', minimum: 0 }, final: { type: 'boolean' },
      download_url: { type: ['string', 'null'] }, expires_in_seconds: { type: ['integer', 'null'] }, expires_at: { type: 'string' },
      videos: { type: 'array', items: { type: 'object' } }, data: { type: 'array', items: { type: 'object' } }, pagination: { type: 'object' }, preview: {},
      segment_downloads: { type: 'array', maxItems: 6, description: 'Direct clip downloads. All available segment links are also included in the JSON. Follow redirects without OAuth headers.', items: {
        type: 'object', required: ['video_id', 'segment_id', 'start_time', 'end_time', 'download_url', 'expires_at'],
        properties: { video_id: { type: 'string' }, segment_id: { type: 'string' }, start_time: { type: 'number' }, end_time: { type: 'number' }, download_url: { type: 'string' }, expires_at: { type: 'string' } },
        additionalProperties: false,
      } },
    }, additionalProperties: false }, next_action: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
    newer_processing: { type: 'array', items: { type: 'object' } },
    files: { type: 'array', items: { type: 'object' } }, errors: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
};

export const WORKFLOW_RESULT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    contract_version: { type: 'integer', const: 2 },
    detail: { type: 'string', enum: ['summary', 'full'] },
    links: { type: 'object', additionalProperties: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object' } },
    ...Object.fromEntries(['run_id', 'prompt_id', 'job_id', 'target_index_id'].map(name => [name, { type: ['string', 'null'] }])),
    ...Object.fromEntries(['status', 'phase', 'source_kind', 'source_id', 'snapshot_id', 'mode', 'result_level', 'captured_at', 'expires_at', 'prompt_name', 'prompt_type', 'billing_status', 'executed_at'].map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(['error_message', 'billing_error'].map(name => [name, { type: ['string', 'null'] }])),
    ...Object.fromEntries(['saved', 'prompt_created_inline', 'video_level_enabled'].map(name => [name, { type: 'boolean' }])),
    ...Object.fromEntries(['total_videos', 'completed_videos', 'failed_videos', 'partial_videos', 'cancelled_videos', 'total_audios', 'completed_audios', 'failed_audios', 'total_images', 'completed_images', 'failed_images', 'total_segments', 'completed_segments', 'billing_estimated_mt', 'billing_actual_mt', 'video_level_total_items', 'video_level_completed_items', 'video_level_failed_items', 'failed_files_count', 'skipped_files_count', 'failed_files_omitted_count', 'skipped_files_omitted_count'].map(name => [name, { type: ['number', 'null'] }])),
    ...Object.fromEntries(['outputs', 'execution', 'progress', 'video_level', 'selection_summary', 'selection_filter', 'execution_config', 'reuse_summary', 'configuration', 'media_breakdown', 'operations', 'prompt', 'draft', 'definition', 'scope', 'coverage', 'destination', 'filtered', 'unfiltered', 'pagination'].map(name => [name, { type: ['object', 'null'] }])),
    failed_files_next_cursor: { type: ['string', 'null'] },
    video_ids: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    ...Object.fromEntries(['failed_files', 'skipped_files'].map(name => [name, {
      type: 'array', maxItems: 100, items: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: {
          ...Object.fromEntries(['path', 'file_id', 'video_id', 'error_code', 'error', 'reason', 'message'].map(key => [key, { type: 'string', maxLength: key.endsWith('_id') ? 512 : 240 }])),
          http_status: { type: 'integer', minimum: 400, maximum: 599 },
          refresh_required: { type: 'boolean' },
        },
      },
    }])),
    data: { type: 'array', items: { type: 'object' } },
    search_id: { type: 'string' },
    results: { type: 'object' },
    next_action: { type: 'object' },
    warnings: { type: 'array', items: {}, maxItems: 5 },
  },
  required: ['contract_version', 'detail', 'links', 'artifacts'],
  additionalProperties: false,
};

export const RESULTS_APP_DEFINITIONS: Tool[] = [
  {
    name: ANALYSIS_VIEW_TOOL,
    title: 'Read analysis progress',
    description: 'Refresh this analysis in the visible Studio. Reads existing progress and completed-video results without starting work. A download intent renews the included JSON link only when requested.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false, oneOf: [{ required: ['analysis_id'] }, { required: ['import_id'] }],
      properties: {
        analysis_id: { type: 'string', minLength: 1 },
        import_id: { type: 'string', minLength: 1 },
        detail: { type: 'string', enum: ['summary', 'full'] },
        cursor: { type: 'string', minLength: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 20 },
        intent: { type: 'string', enum: ['download'], description: 'Renew the included JSON link only after a user requests a download.' },
        video_id: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: STUDIO_SCOPE_TOOL,
    title: 'Browse Studio search scope',
    description: 'List processed media and the latest completed analysis for each video in this Studio container. Explicit analysis selections remain exact.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        index_id: { type: 'string', minLength: 1 },
        video_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        prompt_run_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        cursor: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: STUDIO_PREVIEWS_TOOL,
    title: 'Load Studio previews',
    description: 'Get bounded, short-lived thumbnail and animated preview grants for the Studio. Grants remain in private widget metadata.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { items: {
        type: 'array', minItems: 1, maxItems: 24,
        items: { type: 'object', additionalProperties: false,
          properties: { kind: { type: 'string', enum: ['video', 'segment'] }, video_id: { type: 'string', minLength: 1 }, segment_id: { type: 'string', minLength: 1 } },
          required: ['kind', 'video_id'],
        },
      } },
      required: ['items'],
    },
  },
  {
    name: RESULTS_ARTIFACT_TOOL,
    title: 'Download workflow JSON',
    description: 'Prepare a short-lived download grant for an existing completed JSON artifact. For a user-clicked download in the results card only; never creates an export or loads its contents into the conversation.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source_kind: { type: 'string', enum: ['prompt_run', 'search_snapshot'] },
        source_id: { type: 'string', minLength: 1 },
        scope: { type: 'string', enum: ['all', 'matches', 'search_results'] },
        export_id: { type: 'string', minLength: 1 },
      },
      required: ['source_kind', 'source_id', 'scope', 'export_id'],
    },
  },
  {
    name: RESULTS_VIEW_TOOL,
    title: 'View workflow results',
    description: 'Read an existing result page, or search the selected Studio videos when the user submits a query. Search uses the canonical search API and its authorization and billing.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['search'] },
        container_index_id: { type: 'string', minLength: 1 },
        video_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        query: { type: 'string', maxLength: 2000 },
        filters: { type: 'array', maxItems: 4, items: { type: 'object' } },
        idempotency_key: { type: 'string', minLength: 1 },
        source_kind: { type: 'string', enum: ['prompt_run', 'search_snapshot'] },
        source_id: { type: 'string', minLength: 1 },
        result_level: { type: 'string', enum: ['segment', 'video'] },
        view: { type: 'string', enum: ['both', 'filtered', 'unfiltered'] },
        video_id: { type: 'string', minLength: 1 },
        cursor: { type: 'string', minLength: 1 },
        filtered_cursor: { type: 'string', minLength: 1 },
        unfiltered_cursor: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        include_context: { type: 'boolean', description: 'Include the owned run settings, media identity, and video-level output once for this video. Requires a prompt_run source and video_id.' },
      },
      anyOf: [{ required: ['source_kind', 'source_id'] }, { required: ['action', 'video_ids'] }],
    },
  },
  {
    name: RESULTS_MEDIA_TOOL,
    title: 'Play workflow media',
    description: 'Get a short-lived playback or download grant for an authorized media ID. Segment downloads require existing segment media. For the results card only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        video_id: { type: 'string', minLength: 1 },
        run_id: { type: 'string', minLength: 1 },
        segment_id: { type: 'string', minLength: 1 },
        intent: { type: 'string', enum: ['playback', 'download'] },
      },
      required: ['video_id'],
    },
  },
];
