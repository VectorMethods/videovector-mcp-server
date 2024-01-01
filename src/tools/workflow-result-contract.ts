import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const WORKFLOW_RESULT_TOOLS = new Set([
  'find', 'upload_media', 'define_prompt', 'process_media', 'search_media',
  'get_prompt_run_status', 'get_prompt_run_results', 'get_import_job', 'retry_import_job',
]);
export const WORKFLOW_DETAIL_TOOLS = new Set([
  'define_prompt', 'process_media', 'get_prompt_run_status', 'get_prompt_run_results', 'search_media',
]);
export const RESULTS_CARD_URI = 'ui://videovector/results-card-v2.html';
export const RESULTS_VIEW_TOOL = 'view_workflow_results';
export const RESULTS_MEDIA_TOOL = 'play_workflow_media';
export const RESULTS_ARTIFACT_TOOL = 'download_workflow_artifact';
export const STUDIO_SCOPE_TOOL = 'list_studio_scope';
export const STUDIO_PREVIEWS_TOOL = 'get_studio_previews';
export const RESULTS_APP_TOOLS = new Set([RESULTS_VIEW_TOOL, RESULTS_MEDIA_TOOL, RESULTS_ARTIFACT_TOOL, STUDIO_SCOPE_TOOL, STUDIO_PREVIEWS_TOOL]);
export const DEFAULT_APP_ORIGIN = 'https://app.vectormethods.com';

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
    warnings: { type: 'array', items: {}, maxItems: 5 },
  },
  required: ['contract_version', 'detail', 'links', 'artifacts'],
  additionalProperties: false,
};

export const RESULTS_APP_DEFINITIONS: Tool[] = [
  {
    name: STUDIO_SCOPE_TOOL,
    title: 'Browse Studio search scope',
    description: 'List authorized Playground media, searchable executions, and condition fields for the Studio scope picker. Does not search or process media.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        failed_files_next_cursor: { type: ['string', 'null'] },
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
    description: 'Load an existing result page for the results card. Does not create or rerun a search.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
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
      required: ['source_kind', 'source_id'],
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
