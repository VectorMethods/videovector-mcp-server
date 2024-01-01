import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const ANALYSIS_RESULT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  required: ['analysis_id', 'status', 'terminal', 'stage', 'message', 'progress', 'results', 'next_action'],
  properties: {
    analysis_id: { type: 'string' }, status: { type: 'string' }, terminal: { type: 'boolean', description: 'True only when the analysis execution has ended. Media/indexing work may still be pending; results.final describes the extraction snapshot, not asset readiness.' }, stage: { type: 'string' }, message: { type: 'string' },
    scope: { type: 'object', properties: {
      prompt_id: { type: 'string', description: 'Saved prompt used by this analysis. Available after prompt preparation; reuse it for another analysis with the same instructions.' },
    } }, progress: { type: 'object' },
    results: { type: 'object', properties: {
      included_videos: { type: 'integer', minimum: 0 }, final: { type: 'boolean' },
      download_url: { type: ['string', 'null'] }, expires_in_seconds: { type: ['integer', 'null'] }, expires_at: { type: 'string' },
      videos: { type: 'array', items: { type: 'object' } }, data: { type: 'array', items: { type: 'object' } }, pagination: { type: 'object' },
      segment_downloads: { type: 'array', maxItems: 6, description: 'Direct clip downloads. All available segment links are also included in the JSON. Follow redirects without OAuth headers.', items: {
        type: 'object', required: ['video_id', 'segment_id', 'start_time', 'end_time', 'download_url', 'expires_at'],
        properties: { video_id: { type: 'string' }, segment_id: { type: 'string' }, start_time: { type: 'number' }, end_time: { type: 'number' }, download_url: { type: 'string' }, expires_at: { type: 'string' } },
        additionalProperties: false,
      } },
    }, additionalProperties: false }, next_action: { type: 'object', properties: {
      type: { type: 'string' },
      links: { type: 'object', description: 'Show Open in VideoVector using the returned link for processing and completed analyses. The link opens this exact analysis; never construct app routes from IDs.',
        properties: { open_in_app: { type: 'string', format: 'uri', pattern: '^https://' } }, required: ['open_in_app'], additionalProperties: false },
    }, required: ['type'] },
    newer_processing: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: 'object' } },
    files: { type: 'array', items: { type: 'object' } }, errors: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
};

/** The search facade's public snapshot; analysis/import outputs have their own schemas. */
export const SEARCH_RESULT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    contract_version: { type: 'integer', const: 2 },
    detail: { type: 'string', enum: ['summary', 'full'] },
    links: { type: 'object', additionalProperties: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object' } },
    ...Object.fromEntries(['search_id', 'snapshot_id', 'source_id', 'source_kind', 'mode', 'result_level', 'captured_at', 'expires_at'].map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(['results', 'next_action', 'coverage', 'scope', 'pagination'].map(name => [name, { type: 'object' }])),
    data: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: ['string', 'object'] }, maxItems: 5 },
  },
  required: ['contract_version', 'detail', 'links', 'artifacts', 'results', 'next_action', 'coverage', 'scope', 'pagination', 'data', 'warnings'],
  additionalProperties: false,
};
