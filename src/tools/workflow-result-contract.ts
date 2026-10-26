import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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
