/**
 * MCP Tool Definitions
 *
 * Defines all available tools with their names, descriptions, and input schemas.
 * These definitions are used by the MCP server to expose capabilities to AI hosts.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WORKFLOW_RESULT_TOOLS, WORKFLOW_DETAIL_TOOLS, WORKFLOW_RESULT_SCHEMA, RESULTS_CARD_URI, RESULTS_APP_DEFINITIONS, RESULTS_APP_TOOLS } from './workflow-result-contract.js';

export const ATTACHMENT_PICKER_URI = 'ui://videovector/attachment-picker.html';

export const ATTACHMENT_FILES_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  description: 'Files attached to this message. Pass the host-provided descriptors unchanged.',
  items: {
    type: 'object',
    properties: {
      download_url: { type: 'string', minLength: 1 },
      file_id: { type: 'string', minLength: 1 },
      mime_type: { type: 'string' },
      file_name: { type: 'string' },
    },
    required: ['download_url', 'file_id'],
    additionalProperties: false,
  },
};

const ATTACHMENT_TOOL_META = {
  'openai/fileParams': ['files'],
  'openai/outputTemplate': ATTACHMENT_PICKER_URI,
  'openai/widgetAccessible': true,
  ui: { resourceUri: ATTACHMENT_PICKER_URI },
};

const INTAKE_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    status: { type: 'string' },
    source_kind: { type: 'string' },
    phase: { type: 'string' },
    outputs: { type: 'object', additionalProperties: true },
    execution: { type: 'object', additionalProperties: true },
    failed_files: { type: 'array', items: { type: 'object', additionalProperties: true } },
    video_ids: { type: 'array', items: { type: 'string' } },
    run_id: { type: ['string', 'null'] },
    target_index_id: { type: ['string', 'null'] },
    error_message: { type: ['string', 'null'] },
    progress: { type: 'object', additionalProperties: true },
  },
  required: ['job_id', 'status', 'video_ids'],
  additionalProperties: false,
};

const IMPORT_JOB_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    job_id: { type: 'string' }, status: { type: 'string' },
    video_ids: { type: 'array', items: { type: 'string' } },
    run_id: { type: ['string', 'null'] },
    connector_id: { type: ['string', 'null'] },
    target_index_id: { type: ['string', 'null'] },
    source_kind: { type: 'string' },
    phase: { type: 'string' },
    outputs: { type: 'object', additionalProperties: true },
    execution: { type: 'object', additionalProperties: true },
    failed_files: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['job_id', 'status', 'video_ids'],
  additionalProperties: true,
};

// ============================================================================
// Tool Names (exported for handler mapping)
// ============================================================================

export const TOOL_NAMES = {
  // Simplified Workflow Tools
  UPLOAD_MEDIA: 'upload_media',
  FIND: 'find',
  DEFINE_PROMPT: 'define_prompt',
  PROCESS_MEDIA: 'process_media',
  SEARCH_MEDIA: 'search_media',

  // Search Tools
  SEARCH_VIDEOS: 'search_videos',
  SEARCH_VIDEOS_BY_IMAGE: 'search_videos_by_image',
  MULTIMODAL_SEARCH: 'multimodal_search',
  FILTER_VIDEOS: 'filter_videos',

  // Discovery Tools
  LIST_INDEXES: 'list_indexes',
  GET_INDEX: 'get_index',
  LIST_PROMPTS: 'list_prompts',

  // Video/Segment Tools
  GET_VIDEO: 'get_video',
  GET_VIDEO_SEGMENTS: 'get_video_segments',

  // Prompt Run Tools
  LIST_PROMPT_RUNS: 'list_prompt_runs',
  ESTIMATE_PROMPT_RUN: 'estimate_prompt_run',
  GET_PROMPT_RUN_STATUS: 'get_prompt_run_status',
  CANCEL_PROMPT_RUN: 'cancel_prompt_run',
  GET_PROMPT_RUN_RESULTS: 'get_prompt_run_results',
  GET_PROMPT_RUN_VIDEO_RESULT: 'get_prompt_run_video_result',
  GET_PROMPT_RUN_FAILED_SEGMENTS: 'get_prompt_run_failed_segments',
  RETRY_PROMPT_RUN_SEGMENT: 'retry_prompt_run_segment',
  GET_PROMPT_RUN_SEGMENT_RETRY_STATUS: 'get_prompt_run_segment_retry_status',

  // Prompt Management Tools
  CREATE_PROMPT: 'create_prompt',
  GET_PROMPT: 'get_prompt',
  UPDATE_PROMPT: 'update_prompt',
  TEST_PROMPT_SCHEMA: 'test_prompt_schema',
  GET_PROMPT_USAGE: 'get_prompt_usage',

  // Cloud Connector Tools
  CREATE_GCS_CONNECTOR: 'create_gcs_connector',
  CREATE_S3_CONNECTOR: 'create_s3_connector',
  CREATE_AZURE_CONNECTOR: 'create_azure_connector',
  LIST_CONNECTORS: 'list_connectors',
  TEST_CONNECTOR: 'test_connector',
  BROWSE_CONNECTOR_FILES: 'browse_connector_files',

  // Import Job Tools
  CREATE_IMPORT_JOB: 'create_import_job',
  LIST_IMPORT_JOBS: 'list_import_jobs',
  GET_IMPORT_JOB: 'get_import_job',
  RETRY_IMPORT_JOB: 'retry_import_job',
  CANCEL_IMPORT_JOB: 'cancel_import_job',

  // Index Management Tools
  CREATE_INDEX: 'create_index',

  // Video Management Tools
  LIST_VIDEOS: 'list_videos',
  GET_VIDEOS_STATUS: 'get_videos_status',

  // Export Tools
  EXPORT_INDEX_METADATA: 'export_index_metadata',
  EXPORT_PROMPT_RUN: 'export_prompt_run',
  GET_EXPORT_STATUS: 'get_export_status',
  GET_EXPORT_DOWNLOAD_URL: 'get_export_download_url',

  // Webhook Tools
  CREATE_WEBHOOK: 'create_webhook',
  LIST_WEBHOOKS: 'list_webhooks',
  GET_WEBHOOK: 'get_webhook',
  UPDATE_WEBHOOK: 'update_webhook',
  LIST_WEBHOOK_EVENTS: 'list_webhook_events',
  TEST_WEBHOOK: 'test_webhook',
  LIST_WEBHOOK_DELIVERIES: 'list_webhook_deliveries',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
export type ToolRequiredScope = 'search' | 'read' | 'write';

export interface ToolDefinitionOptions {
  includeAppTools?: boolean;
  advertiseOAuth?: boolean;
}

interface OAuth2SecurityScheme {
  type: 'oauth2';
  scopes: string[];
}

type OAuthAdvertisedTool = Tool & {
  securitySchemes: OAuth2SecurityScheme[];
};

const TOOL_TITLES: Record<ToolName, string> = {
  [TOOL_NAMES.UPLOAD_MEDIA]: 'Upload Media',
  [TOOL_NAMES.FIND]: 'Find Matching Video Segments',
  [TOOL_NAMES.DEFINE_PROMPT]: 'Define Prompt',
  [TOOL_NAMES.PROCESS_MEDIA]: 'Process Media',
  [TOOL_NAMES.SEARCH_MEDIA]: 'Search Media',
  [TOOL_NAMES.SEARCH_VIDEOS]: 'Search Videos',
  [TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE]: 'Search Videos by Image',
  [TOOL_NAMES.MULTIMODAL_SEARCH]: 'Run Multimodal Search',
  [TOOL_NAMES.FILTER_VIDEOS]: 'Filter Videos',
  [TOOL_NAMES.LIST_INDEXES]: 'List Indexes',
  [TOOL_NAMES.GET_INDEX]: 'Get Index',
  [TOOL_NAMES.LIST_PROMPTS]: 'List Prompts',
  [TOOL_NAMES.GET_VIDEO]: 'Get Video',
  [TOOL_NAMES.GET_VIDEO_SEGMENTS]: 'Get Video Segments',
  [TOOL_NAMES.LIST_PROMPT_RUNS]: 'List Prompt Runs',
  [TOOL_NAMES.ESTIMATE_PROMPT_RUN]: 'Estimate Prompt Run',
  [TOOL_NAMES.GET_PROMPT_RUN_STATUS]: 'Get Prompt Run Status',
  [TOOL_NAMES.CANCEL_PROMPT_RUN]: 'Cancel Prompt Run',
  [TOOL_NAMES.GET_PROMPT_RUN_RESULTS]: 'Get Prompt Run Results',
  [TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT]: 'Get Prompt Run Video Result',
  [TOOL_NAMES.GET_PROMPT_RUN_FAILED_SEGMENTS]: 'Get Failed Prompt Run Segments',
  [TOOL_NAMES.RETRY_PROMPT_RUN_SEGMENT]: 'Retry Prompt Run Segment',
  [TOOL_NAMES.GET_PROMPT_RUN_SEGMENT_RETRY_STATUS]: 'Get Segment Retry Status',
  [TOOL_NAMES.CREATE_PROMPT]: 'Create Prompt',
  [TOOL_NAMES.GET_PROMPT]: 'Get Prompt',
  [TOOL_NAMES.UPDATE_PROMPT]: 'Update Prompt',
  [TOOL_NAMES.TEST_PROMPT_SCHEMA]: 'Test Prompt Schema',
  [TOOL_NAMES.GET_PROMPT_USAGE]: 'Get Prompt Usage',
  [TOOL_NAMES.CREATE_GCS_CONNECTOR]: 'Create Google Cloud Storage Connector',
  [TOOL_NAMES.CREATE_S3_CONNECTOR]: 'Create Amazon S3 Connector',
  [TOOL_NAMES.CREATE_AZURE_CONNECTOR]: 'Create Azure Blob Storage Connector',
  [TOOL_NAMES.LIST_CONNECTORS]: 'List Cloud Connectors',
  [TOOL_NAMES.TEST_CONNECTOR]: 'Test Cloud Connector',
  [TOOL_NAMES.BROWSE_CONNECTOR_FILES]: 'Browse Cloud Connector Files',
  [TOOL_NAMES.CREATE_IMPORT_JOB]: 'Create Import Job',
  [TOOL_NAMES.LIST_IMPORT_JOBS]: 'List Import Jobs',
  [TOOL_NAMES.GET_IMPORT_JOB]: 'Get Import Job',
  [TOOL_NAMES.RETRY_IMPORT_JOB]: 'Retry Import Job',
  [TOOL_NAMES.CANCEL_IMPORT_JOB]: 'Cancel Import Job',
  [TOOL_NAMES.CREATE_INDEX]: 'Create Index',
  [TOOL_NAMES.LIST_VIDEOS]: 'List Videos',
  [TOOL_NAMES.GET_VIDEOS_STATUS]: 'Get Video Statuses',
  [TOOL_NAMES.EXPORT_INDEX_METADATA]: 'Export Index Metadata',
  [TOOL_NAMES.EXPORT_PROMPT_RUN]: 'Export Prompt Run',
  [TOOL_NAMES.GET_EXPORT_STATUS]: 'Get Export Status',
  [TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL]: 'Get Export Download URL',
  [TOOL_NAMES.CREATE_WEBHOOK]: 'Create Webhook',
  [TOOL_NAMES.LIST_WEBHOOKS]: 'List Webhooks',
  [TOOL_NAMES.GET_WEBHOOK]: 'Get Webhook',
  [TOOL_NAMES.UPDATE_WEBHOOK]: 'Update Webhook',
  [TOOL_NAMES.LIST_WEBHOOK_EVENTS]: 'List Webhook Events',
  [TOOL_NAMES.TEST_WEBHOOK]: 'Test Webhook',
  [TOOL_NAMES.LIST_WEBHOOK_DELIVERIES]: 'List Webhook Deliveries',
};

/**
 * Minimal result contracts for tools that currently return structuredContent.
 * Keep these focused on stable wrapper fields; nested backend records remain
 * extensible so adding non-breaking API response fields cannot invalidate MCP
 * responses that were otherwise handled successfully.
 */
const TOOL_OUTPUT_SCHEMAS: Partial<
  Record<ToolName, NonNullable<Tool['outputSchema']>>
> = {
  [TOOL_NAMES.UPLOAD_MEDIA]: INTAKE_OUTPUT_SCHEMA,
  [TOOL_NAMES.FIND]: INTAKE_OUTPUT_SCHEMA,
  [TOOL_NAMES.GET_IMPORT_JOB]: IMPORT_JOB_OUTPUT_SCHEMA,
  [TOOL_NAMES.RETRY_IMPORT_JOB]: IMPORT_JOB_OUTPUT_SCHEMA,
  [TOOL_NAMES.DEFINE_PROMPT]: {
    type: 'object',
    properties: {
      prompt_id: { type: ['string', 'null'] },
      prompt: { type: ['object', 'null'], additionalProperties: true },
      draft: { type: ['object', 'null'], additionalProperties: true },
      definition: { type: 'object', additionalProperties: true },
      saved: { type: 'boolean' },
    },
    additionalProperties: true,
  },
  [TOOL_NAMES.PROCESS_MEDIA]: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      run: { type: 'object', additionalProperties: true },
      prompt: { type: 'object', additionalProperties: true },
      prompt_created_inline: { type: 'boolean' },
      results_url: { type: 'string' },
      status_url: { type: 'string' },
    },
    required: ['run_id', 'run', 'prompt', 'prompt_created_inline', 'status_url', 'results_url'],
    additionalProperties: true,
  },
  [TOOL_NAMES.SEARCH_MEDIA]: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      mode: { type: 'string', enum: ['vector', 'condition'] },
      result_level: { type: 'string', enum: ['segment', 'video'] },
      pagination: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          count: { type: 'integer' },
          has_more: { type: 'boolean' },
          next_cursor: { type: ['string', 'null'] },
          result_window: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: [
          'limit',
          'count',
          'has_more',
          'next_cursor',
          'result_window',
          'truncated',
        ],
        additionalProperties: true,
      },
      scope: { type: 'object', additionalProperties: true },
      coverage: { type: 'object', additionalProperties: true },
      warnings: { type: 'array', items: {} },
    },
    required: ['data', 'mode', 'result_level', 'pagination'],
    additionalProperties: true,
  },
  [TOOL_NAMES.SEARCH_VIDEOS]: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      index_id: { type: 'string' },
      total_results: { type: 'integer', minimum: 0 },
      segment_enrichment: { type: 'object', additionalProperties: true },
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['query', 'index_id', 'total_results', 'segment_enrichment', 'results'],
    additionalProperties: true,
  },
  [TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE]: {
    type: 'object',
    properties: {
      index_id: { type: 'string' },
      search_type: { type: 'string', enum: ['image'] },
      total_results: { type: 'integer', minimum: 0 },
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['index_id', 'search_type', 'total_results', 'results'],
    additionalProperties: true,
  },
  [TOOL_NAMES.MULTIMODAL_SEARCH]: {
    type: 'object',
    properties: {
      index_id: { type: 'string' },
      search_type: { type: 'string', enum: ['multimodal'] },
      text_query: { type: ['string', 'null'] },
      has_image: { type: 'boolean' },
      text_weight: { type: 'number' },
      image_weight: { type: 'number' },
      total_results: { type: 'integer', minimum: 0 },
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: [
      'index_id',
      'search_type',
      'text_query',
      'has_image',
      'text_weight',
      'image_weight',
      'total_results',
      'results',
    ],
    additionalProperties: true,
  },
  [TOOL_NAMES.FILTER_VIDEOS]: {
    type: 'object',
    properties: {
      index_id: { type: 'string' },
      search_type: { type: 'string', enum: ['filter'] },
      conditions: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      total_results: { type: 'integer', minimum: 0 },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] },
      results: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: [
      'index_id',
      'search_type',
      'conditions',
      'total_results',
      'has_more',
      'next_cursor',
      'results',
    ],
    additionalProperties: true,
  },
  [TOOL_NAMES.LIST_INDEXES]: {
    type: 'object',
    properties: {
      total_indexes: { type: 'integer', minimum: 0 },
      user_indexes: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      default_indexes: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      tip: { type: 'string' },
    },
    required: ['total_indexes', 'user_indexes', 'tip'],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_INDEX]: {
    type: 'object',
    properties: {
      index_id: { type: 'string' },
      name: { type: 'string' },
      is_default: { type: 'boolean' },
      created_at: { type: 'string' },
      description: { type: ['string', 'null'] },
      sort_order: { type: ['number', 'null'] },
    },
    required: [
      'index_id',
      'name',
      'is_default',
      'created_at',
      'description',
      'sort_order',
    ],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_VIDEO]: {
    type: 'object',
    properties: {
      video_id: { type: 'string' },
      title: { type: 'string' },
      media_type: { type: 'string' },
      status: { type: 'string' },
      processing_summary: { type: 'object', additionalProperties: true },
      processing_status: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: [
      'video_id',
      'title',
      'media_type',
      'status',
      'processing_summary',
      'processing_status',
    ],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_VIDEO_SEGMENTS]: {
    type: 'object',
    properties: {
      video_id: { type: 'string' },
      run_id: { type: ['string', 'null'] },
      total_segments: { type: 'integer', minimum: 0 },
      has_more: { type: 'boolean' },
      segments: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['video_id', 'run_id', 'total_segments', 'has_more', 'segments'],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_PROMPT_RUN_STATUS]: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      status: { type: 'string' },
      selection_filter: { type: ['object', 'null'], additionalProperties: true },
      selection_summary: { type: 'object', additionalProperties: true },
      reuse_summary: { type: 'object', additionalProperties: true },
    },
    required: ['run_id', 'status'],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_PROMPT_RUN_RESULTS]: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      status: { type: 'string' },
      result_level: { type: 'string', enum: ['segment', 'video'] },
      selection_filter: { type: ['object', 'null'], additionalProperties: true },
      selection_summary: { type: 'object', additionalProperties: true },
      ...Object.fromEntries(['filtered', 'unfiltered'].map((name) => [name, {
        type: ['object', 'null'],
        properties: {
          data: { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 50 },
          pagination: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 50 },
              has_more: { type: 'boolean' },
              next_cursor: { type: ['string', 'null'] },
            },
            required: ['limit', 'has_more', 'next_cursor'],
            additionalProperties: false,
          },
        },
        required: ['data', 'pagination'],
        additionalProperties: false,
      }])),
    },
    required: ['run_id', 'status', 'result_level', 'selection_filter', 'selection_summary', 'filtered', 'unfiltered'],
    additionalProperties: false,
  },
  [TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT]: {
    type: 'object',
    properties: {
      result_type: { type: 'string' },
      result_id: { type: 'string' },
      run_id: { type: 'string' },
      prompt_run_id: { type: 'string' },
      video_id: { type: 'string' },
      status: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
    },
    required: ['result_type', 'result_id', 'run_id', 'prompt_run_id', 'video_id'],
    additionalProperties: true,
  },
  [TOOL_NAMES.LIST_VIDEOS]: {
    type: 'object',
    properties: {
      index_id: { type: 'string' },
      videos_returned: { type: 'integer', minimum: 0 },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] },
      by_status: { type: 'object', additionalProperties: { type: 'integer' } },
      by_media_type: { type: 'object', additionalProperties: { type: 'integer' } },
      by_run_status: { type: 'object', additionalProperties: { type: 'integer' } },
      segment_status_totals: { type: 'object', additionalProperties: { type: 'integer' } },
      videos_with_processing_details: { type: 'integer', minimum: 0 },
      videos: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      tip: { type: 'string' },
    },
    required: [
      'index_id',
      'videos_returned',
      'has_more',
      'next_cursor',
      'by_status',
      'by_media_type',
      'by_run_status',
      'segment_status_totals',
      'videos_with_processing_details',
      'videos',
    ],
    additionalProperties: true,
  },
  [TOOL_NAMES.GET_EXPORT_STATUS]: {
    type: 'object',
    properties: {
      export_id: { type: 'string' },
      export_type: { type: 'string', enum: ['index', 'prompt_run', 'search_snapshot'] },
      target_id: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed'],
      },
      created_at: { type: ['string', 'null'] },
      available_at: { type: ['string', 'null'] },
      started_at: { type: ['string', 'null'] },
      completed_at: { type: ['string', 'null'] },
      updated_at: { type: ['string', 'null'] },
      download_url: { type: ['string', 'null'] },
      links: {
        type: 'object',
        properties: {
          open_in_app: { type: 'string' },
          download_json: { type: 'string' },
        },
        required: ['open_in_app'],
        additionalProperties: false,
      },
      file_size_bytes: { type: ['integer', 'null'], minimum: 0 },
      error_message: { type: ['string', 'null'] },
      destination_type: {
        type: 'string',
        enum: ['download', 'connector'],
      },
      destination_connector_id: { type: ['string', 'null'] },
      destination_uri: { type: ['string', 'null'] },
      tip: { type: 'string' },
    },
    required: [
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
      'destination_uri',
      'tip',
    ],
    additionalProperties: true,
  },
};

export const TOOL_CATEGORIES: Record<ToolName, string> = {
  [TOOL_NAMES.UPLOAD_MEDIA]: 'Workflow',
  [TOOL_NAMES.FIND]: 'Workflow',
  [TOOL_NAMES.DEFINE_PROMPT]: 'Workflow',
  [TOOL_NAMES.PROCESS_MEDIA]: 'Workflow',
  [TOOL_NAMES.SEARCH_MEDIA]: 'Workflow',
  [TOOL_NAMES.SEARCH_VIDEOS]: 'Search',
  [TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE]: 'Search',
  [TOOL_NAMES.MULTIMODAL_SEARCH]: 'Search',
  [TOOL_NAMES.FILTER_VIDEOS]: 'Search',
  [TOOL_NAMES.LIST_INDEXES]: 'Discovery',
  [TOOL_NAMES.GET_INDEX]: 'Discovery',
  [TOOL_NAMES.LIST_PROMPTS]: 'Discovery',
  [TOOL_NAMES.GET_VIDEO]: 'Video',
  [TOOL_NAMES.GET_VIDEO_SEGMENTS]: 'Video',
  [TOOL_NAMES.LIST_PROMPT_RUNS]: 'Prompt runs',
  [TOOL_NAMES.ESTIMATE_PROMPT_RUN]: 'Prompt runs',
  [TOOL_NAMES.GET_PROMPT_RUN_STATUS]: 'Prompt runs',
  [TOOL_NAMES.CANCEL_PROMPT_RUN]: 'Prompt runs',
  [TOOL_NAMES.GET_PROMPT_RUN_RESULTS]: 'Prompt runs',
  [TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT]: 'Prompt runs',
  [TOOL_NAMES.GET_PROMPT_RUN_FAILED_SEGMENTS]: 'Prompt runs',
  [TOOL_NAMES.RETRY_PROMPT_RUN_SEGMENT]: 'Prompt runs',
  [TOOL_NAMES.GET_PROMPT_RUN_SEGMENT_RETRY_STATUS]: 'Prompt runs',
  [TOOL_NAMES.CREATE_PROMPT]: 'Prompt management',
  [TOOL_NAMES.GET_PROMPT]: 'Prompt management',
  [TOOL_NAMES.UPDATE_PROMPT]: 'Prompt management',
  [TOOL_NAMES.TEST_PROMPT_SCHEMA]: 'Prompt management',
  [TOOL_NAMES.GET_PROMPT_USAGE]: 'Prompt management',
  [TOOL_NAMES.CREATE_GCS_CONNECTOR]: 'Cloud connectors',
  [TOOL_NAMES.CREATE_S3_CONNECTOR]: 'Cloud connectors',
  [TOOL_NAMES.CREATE_AZURE_CONNECTOR]: 'Cloud connectors',
  [TOOL_NAMES.LIST_CONNECTORS]: 'Cloud connectors',
  [TOOL_NAMES.TEST_CONNECTOR]: 'Cloud connectors',
  [TOOL_NAMES.BROWSE_CONNECTOR_FILES]: 'Cloud connectors',
  [TOOL_NAMES.CREATE_IMPORT_JOB]: 'Import jobs',
  [TOOL_NAMES.LIST_IMPORT_JOBS]: 'Import jobs',
  [TOOL_NAMES.GET_IMPORT_JOB]: 'Import jobs',
  [TOOL_NAMES.RETRY_IMPORT_JOB]: 'Import jobs',
  [TOOL_NAMES.CANCEL_IMPORT_JOB]: 'Import jobs',
  [TOOL_NAMES.CREATE_INDEX]: 'Indexes',
  [TOOL_NAMES.LIST_VIDEOS]: 'Videos',
  [TOOL_NAMES.GET_VIDEOS_STATUS]: 'Videos',
  [TOOL_NAMES.EXPORT_INDEX_METADATA]: 'Exports',
  [TOOL_NAMES.EXPORT_PROMPT_RUN]: 'Exports',
  [TOOL_NAMES.GET_EXPORT_STATUS]: 'Exports',
  [TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL]: 'Exports',
  [TOOL_NAMES.CREATE_WEBHOOK]: 'Webhooks',
  [TOOL_NAMES.LIST_WEBHOOKS]: 'Webhooks',
  [TOOL_NAMES.GET_WEBHOOK]: 'Webhooks',
  [TOOL_NAMES.UPDATE_WEBHOOK]: 'Webhooks',
  [TOOL_NAMES.LIST_WEBHOOK_EVENTS]: 'Webhooks',
  [TOOL_NAMES.TEST_WEBHOOK]: 'Webhooks',
  [TOOL_NAMES.LIST_WEBHOOK_DELIVERIES]: 'Webhooks',
};

export const FILTER_CONDITION_VALIDATION = {
  max_conditions: 4,
  allowed_request_fields: ['index_id', 'conditions', 'page_size', 'cursor', 'run_ids', 'index_ids'],
  allowed_condition_fields: ['field', 'operator', 'value', 'type'],
  supported_types: ['string', 'integer', 'number', 'boolean', 'array'],
  operators_by_type: {
    string: [
      { value: 'equals', requires_value: true },
      { value: 'contains', requires_value: true },
      { value: 'starts_with', requires_value: true },
      { value: 'ends_with', requires_value: true },
      { value: 'is_empty', requires_value: false },
      { value: 'is_not_empty', requires_value: false },
    ],
    integer: [
      { value: 'equals', requires_value: true },
      { value: 'greater_than', requires_value: true },
      { value: 'greater_equal', requires_value: true },
      { value: 'less_than', requires_value: true },
      { value: 'less_equal', requires_value: true },
    ],
    number: [
      { value: 'equals', requires_value: true },
      { value: 'greater_than', requires_value: true },
      { value: 'greater_equal', requires_value: true },
      { value: 'less_than', requires_value: true },
      { value: 'less_equal', requires_value: true },
    ],
    boolean: [{ value: 'equals', requires_value: true }],
    array: [
      { value: 'item_equals', requires_value: true },
      { value: 'item_contains', requires_value: true },
      { value: 'length_equals', requires_value: true },
      { value: 'length_greater', requires_value: true },
      { value: 'length_less', requires_value: true },
      { value: 'is_empty', requires_value: false },
      { value: 'is_not_empty', requires_value: false },
    ],
  },
  forbidden_condition_fields: ['fuzzyMatch'],
  pagination: {
    cursor_field: 'cursor',
    forbidden_fields: ['start_after'],
  },
} as const;

const ARRAY_LENGTH_FILTER_OPERATORS = new Set(['length_equals', 'length_greater', 'length_less']);

function getFilterConditionValueSchema(type: string, operator: string): Record<string, unknown> {
  if (type === 'string') {
    return { type: 'string' };
  }
  if (type === 'integer') {
    return { type: 'integer' };
  }
  if (type === 'number') {
    return { type: 'number' };
  }
  if (type === 'boolean') {
    return { type: 'boolean' };
  }
  if (type === 'array' && ARRAY_LENGTH_FILTER_OPERATORS.has(operator)) {
    return { type: 'integer', minimum: 0 };
  }
  if (type === 'array' && operator === 'item_contains') {
    return { type: 'string' };
  }
  if (type === 'array' && operator === 'item_equals') {
    return {
      oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    };
  }
  return {};
}

const FILTER_CONDITION_SCHEMA_VARIANTS = Object.entries(
  FILTER_CONDITION_VALIDATION.operators_by_type
).flatMap(([type, operators]) =>
  operators.map((operator) => ({
    properties: {
      type: { enum: [type] },
      operator: { enum: [operator.value] },
      ...(operator.requires_value
        ? { value: getFilterConditionValueSchema(type, operator.value) }
        : {}),
    },
    required: operator.requires_value
      ? ['field', 'operator', 'type', 'value']
      : ['field', 'operator', 'type'],
    ...(operator.requires_value ? {} : { not: { required: ['value'] } }),
  }))
);

const EXECUTION_CONFIGURATION_PROPERTIES = {
  video_segmentation_type: { type: 'string', enum: ['fixed', 'content_aware'] },
  audio_segmentation_type: { type: 'string', enum: ['fixed', 'content_aware'] },
  video_segment_duration: { type: ['integer', 'null'], minimum: 1, maximum: 300 },
  audio_segment_duration: { type: ['integer', 'null'], minimum: 1, maximum: 300 },
  processing_model: { type: ['string', 'null'], minLength: 1, description: 'Model ID published by the billing pricing API.' },
  enable_transcription: { type: 'boolean' },
  enable_image_embedding: { type: 'boolean' },
};

const SELECTION_FILTER_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    logic: { type: 'string', enum: ['and', 'or'] },
    conditions: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1 },
          operator: { type: 'string' },
          type: { type: 'string', enum: FILTER_CONDITION_VALIDATION.supported_types },
          item_type: { type: ['string', 'null'], enum: ['string', 'integer', 'number', 'boolean', null] },
          value: {},
        },
        oneOf: FILTER_CONDITION_SCHEMA_VARIANTS.map(({ not, ...variant }) => (
          not ? { ...variant, properties: { ...variant.properties, value: { type: 'null' } } } : variant
        )),
        additionalProperties: false,
      },
    },
  },
  required: ['logic', 'conditions'],
  additionalProperties: false,
};

const SELECTION_FILTER_SCHEMA = {
  type: ['object', 'null'],
  description: 'Optional schema-bound selection after extraction. At most four conditions total. Fields and types must match the corresponding segment or video schema.',
  properties: {
    segment: { ...SELECTION_FILTER_GROUP_SCHEMA, type: ['object', 'null'] },
    video: { ...SELECTION_FILTER_GROUP_SCHEMA, type: ['object', 'null'] },
    level_logic: { type: 'string', enum: ['and', 'or'] },
  },
  required: ['level_logic'],
  anyOf: [{ required: ['segment'] }, { required: ['video'] }],
  additionalProperties: false,
};

const READ_ONLY_TOOLS = new Set<ToolName>([
  TOOL_NAMES.FILTER_VIDEOS,
  TOOL_NAMES.LIST_INDEXES,
  TOOL_NAMES.GET_INDEX,
  TOOL_NAMES.LIST_PROMPTS,
  TOOL_NAMES.GET_VIDEO,
  TOOL_NAMES.GET_VIDEO_SEGMENTS,
  TOOL_NAMES.LIST_PROMPT_RUNS,
  TOOL_NAMES.ESTIMATE_PROMPT_RUN,
  TOOL_NAMES.GET_PROMPT_RUN_STATUS,
  TOOL_NAMES.GET_PROMPT_RUN_RESULTS,
  TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT,
  TOOL_NAMES.GET_PROMPT_RUN_FAILED_SEGMENTS,
  TOOL_NAMES.GET_PROMPT_RUN_SEGMENT_RETRY_STATUS,
  TOOL_NAMES.GET_PROMPT,
  TOOL_NAMES.TEST_PROMPT_SCHEMA,
  TOOL_NAMES.GET_PROMPT_USAGE,
  TOOL_NAMES.LIST_CONNECTORS,
  TOOL_NAMES.BROWSE_CONNECTOR_FILES,
  TOOL_NAMES.LIST_IMPORT_JOBS,
  TOOL_NAMES.GET_IMPORT_JOB,
  TOOL_NAMES.LIST_VIDEOS,
  TOOL_NAMES.GET_VIDEOS_STATUS,
  TOOL_NAMES.GET_EXPORT_STATUS,
  TOOL_NAMES.LIST_WEBHOOKS,
  TOOL_NAMES.GET_WEBHOOK,
  TOOL_NAMES.LIST_WEBHOOK_EVENTS,
  TOOL_NAMES.LIST_WEBHOOK_DELIVERIES,
]);

// These operations do not mutate tenant state, but the backend deliberately
// gates them behind write scope. Keep the MCP read-only annotation independent
// from the API authorization contract.
const WRITE_SCOPE_READ_ONLY_TOOLS = new Set<ToolName>([
  TOOL_NAMES.TEST_PROMPT_SCHEMA,
]);

// These operations retain their established backend read scope even though
// they create durable billing/usage or capability state. They must not be
// advertised as read-only or idempotent to OpenAI clients.
const READ_SCOPE_NON_READ_ONLY_TOOLS = new Set<ToolName>([
  TOOL_NAMES.SEARCH_VIDEOS,
  TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE,
  TOOL_NAMES.MULTIMODAL_SEARCH,
  TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL,
]);

const SEARCH_SCOPE_TOOLS = new Set<ToolName>([
  TOOL_NAMES.SEARCH_MEDIA,
]);

const DESTRUCTIVE_TOOLS = new Set<ToolName>([
  TOOL_NAMES.CANCEL_PROMPT_RUN,
  TOOL_NAMES.RETRY_PROMPT_RUN_SEGMENT,
  TOOL_NAMES.UPDATE_PROMPT,
  TOOL_NAMES.CANCEL_IMPORT_JOB,
  TOOL_NAMES.RETRY_IMPORT_JOB,
  TOOL_NAMES.UPDATE_WEBHOOK,
  TOOL_NAMES.TEST_WEBHOOK,
]);

// OpenAI's review contract uses openWorldHint for writes that can change state
// beyond VideoVector's private boundary. Export jobs can write to a customer's
// configured cloud destination, and webhook tests send an irreversible request
// to the customer's external endpoint. Read-only browsing, connector health
// probes, first-party import state, and capability minting remain closed-world.
const OPEN_WORLD_TOOLS = new Set<ToolName>([
  TOOL_NAMES.EXPORT_INDEX_METADATA,
  TOOL_NAMES.EXPORT_PROMPT_RUN,
  TOOL_NAMES.TEST_WEBHOOK,
]);

export function getToolCategory(name: string): string {
  return TOOL_CATEGORIES[name as ToolName] ?? 'Other';
}

export function getToolRequiredScope(name: string): ToolRequiredScope {
  if (RESULTS_APP_TOOLS.has(name)) return 'read';
  if (SEARCH_SCOPE_TOOLS.has(name as ToolName)) {
    return 'search';
  }
  if (WRITE_SCOPE_READ_ONLY_TOOLS.has(name as ToolName)) {
    return 'write';
  }
  return (
    READ_ONLY_TOOLS.has(name as ToolName)
    || READ_SCOPE_NON_READ_ONLY_TOOLS.has(name as ToolName)
  ) ? 'read' : 'write';
}

export function getToolAnnotations(name: string): NonNullable<Tool['annotations']> {
  const readOnly = READ_ONLY_TOOLS.has(name as ToolName);

  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name as ToolName),
    idempotentHint: readOnly,
    openWorldHint: OPEN_WORLD_TOOLS.has(name as ToolName),
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

const BASE_TOOL_DEFINITIONS: Tool[] = [
  // --------------------------------------------------------------------------
  // Simplified Workflow Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.FIND,
    description: `Find matching segments in videos attached to this message.

This starts a fresh Playground workflow: upload the supplied videos, generate extraction schemas and optional filters together, and execute across exactly those videos. Transcription and image embeddings are off. Video segmentation uses content-aware processing.

Prefer files forwarded by the host. Omit files only when the host cannot forward the videos; an inline picker will collect them. Local stdio clients can supply file_paths. Poll get_import_job with job_id until run_id is available, then get_prompt_run_status and get_prompt_run_results(view="both"). Each new command starts fresh; reuse idempotency_key only when retrying that command.`,
    _meta: ATTACHMENT_TOOL_META,
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', minLength: 1, maxLength: 12000 },
        files: ATTACHMENT_FILES_SCHEMA,
        file_paths: {
          type: 'array', minItems: 1, maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Local stdio only: video paths within allowed upload roots.',
        },
        idempotency_key: { type: 'string', minLength: 1 },
      },
      required: ['instruction'],
      additionalProperties: false,
      not: { required: ['files', 'file_paths'] },
    },
  },
  {
    name: TOOL_NAMES.UPLOAD_MEDIA,
    description: `Upload attached media through a durable import job.

Prefer host-provided files. Omit files only when the host cannot forward attachments; an inline picker will collect them. Local stdio clients can supply file_path within allowed upload roots. Destination defaults to Playground; index_id selects an existing index and index_name reuses or creates a private index. Poll get_import_job with the returned job_id. To upload and immediately find matching segments, use find.`,
    _meta: ATTACHMENT_TOOL_META,
    inputSchema: {
      type: 'object',
      properties: {
        files: ATTACHMENT_FILES_SCHEMA,
        file_path: {
          type: 'string',
          minLength: 1,
          description: 'Path to a local video, audio, or image file inside an allowed upload root.',
        },
        title: {
          type: 'string',
          minLength: 1,
          description: 'Optional media title. Defaults to the filename stem.',
        },
        index_id: {
          type: 'string',
          minLength: 1,
          description: 'Existing destination index ID. Omit to use Playground.',
        },
        index_name: {
          type: 'string',
          minLength: 1,
          description: 'Exact private index name to reuse or create when absent.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Optional stable retry identity. One is generated automatically when omitted.',
        },
      },
      additionalProperties: false,
      allOf: [
        { not: { required: ['index_id', 'index_name'] } },
        { not: { required: ['files', 'file_path'] } },
      ],
    },
  },
  {
    name: TOOL_NAMES.DEFINE_PROMPT,
    description: `Turn a natural-language instruction into a VideoVector prompt using Prompt Lab.

The same generation call returns extraction schemas and an optional selection_filter only when the user wants to find, filter, or shortlist matching media. The generated instructions reflect supported segmentation intent, such as concise social clips or useful context around a target moment. The generated prompt is saved by default and the returned prompt_id can be passed directly to process_media. Set save=false only when the user explicitly wants a draft.`,
    inputSchema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          minLength: 1,
          description: 'What information the prompt should extract from the media.',
        },
        save: {
          type: 'boolean',
          default: true,
          description: 'Persist the generated prompt and return a prompt_id.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Optional stable retry identity. One is generated automatically when omitted.',
        },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.PROCESS_MEDIA,
    description: `Process media with one prompt using a minimal target contract.

Provide prompt_id or an inline prompt_instruction. With no target, the entire Playground is processed. Provide index_id/index_name for an index, video_ids for selected media, or import_job_id to process every published part of a completed import (exclusive with video_ids). Omitted execution settings inherit the engine configuration. Video and audio support fixed or content_aware segmentation, with content_aware as the default. The prompt may include an optional post-extraction selection filter. Returns a run immediately; poll get_prompt_run_status, then use get_prompt_run_results for both filtered and unfiltered pages.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          minLength: 1,
          description: 'Existing prompt ID to run.',
        },
        prompt_instruction: {
          type: 'string',
          minLength: 1,
          description: 'Inline instruction to generate, save, and run as a prompt.',
        },
        import_job_id: { type: 'string', minLength: 1, description: 'Completed import whose full ordered output manifest is processed. Exclusive with video_ids; never use only the first page of imported video_ids.' },
        video_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'One or more media IDs. Omit to process the selected whole container.',
        },
        index_id: {
          type: 'string',
          minLength: 1,
          description: 'Existing index target or container for video_ids.',
        },
        index_name: {
          type: 'string',
          minLength: 1,
          description: 'Exact existing private index name. Processing never creates indexes.',
        },
        ...EXECUTION_CONFIGURATION_PROPERTIES,
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Optional stable retry identity. One is generated automatically when omitted.',
        },
      },
      additionalProperties: false,
      allOf: [
        {
          oneOf: [
            { required: ['prompt_id'], not: { required: ['prompt_instruction'] } },
            { required: ['prompt_instruction'], not: { required: ['prompt_id'] } },
          ],
        },
        { not: { required: ['index_id', 'index_name'] } },
      ],
    },
  },
  {
    name: TOOL_NAMES.SEARCH_MEDIA,
    description: `Search processed media without first navigating VideoVector's internal abstractions.

Use query for semantic vector search, filters for conditional search, or both to filter the ranked semantic result window. With no scope, search the Playground. Scope by index, media IDs, or prompt-run IDs. Pass only cursor to retrieve the next frozen page without rerunning or rebilling the search. Compatible clients display the ranked results in an interactive player with formatted analysis. Keep replies brief when that viewer is visible; otherwise present the returned viewing and JSON links.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Natural-language vector search query.',
        },
        filters: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: 'Conditional metadata filters combined with AND logic.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1 },
              operator: {
                type: 'string',
                enum: [
                  'equals',
                  'greater_than',
                  'greater_equal',
                  'less_than',
                  'less_equal',
                  'contains',
                  'starts_with',
                  'ends_with',
                  'is_empty',
                  'is_not_empty',
                  'item_equals',
                  'item_contains',
                  'length_equals',
                  'length_greater',
                  'length_less',
                ],
                default: 'equals',
              },
              value: {},
            },
            required: ['field'],
            additionalProperties: false,
          },
        },
        result_level: {
          type: 'string',
          enum: ['segment', 'video'],
          default: 'segment',
          description: 'Search segment extraction results or video-level extraction results.',
        },
        video_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Search every searchable prompt run containing these media IDs.',
        },
        prompt_run_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
          description: 'Search exactly these prompt runs.',
        },
        index_id: {
          type: 'string',
          minLength: 1,
          description: 'Existing index to search. Omit all scope fields for Playground.',
        },
        index_name: {
          type: 'string',
          minLength: 1,
          description: 'Exact existing private index name to search.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Results to return on this page.',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description: 'Opaque next_cursor. When set, omit every other argument.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Optional stable identity for starting a search. Not used with cursor.',
        },
      },
      additionalProperties: false,
      allOf: [
        {
          not: {
            anyOf: [
              { required: ['index_id', 'index_name'] },
              { required: ['video_ids', 'prompt_run_ids'] },
              { required: ['video_ids', 'index_id'] },
              { required: ['video_ids', 'index_name'] },
              { required: ['prompt_run_ids', 'index_id'] },
              { required: ['prompt_run_ids', 'index_name'] },
            ],
          },
        },
        {
          oneOf: [
            { anyOf: [{ required: ['query'] }, { required: ['filters'] }], not: { required: ['cursor'] } },
            {
              required: ['cursor'],
              not: {
                anyOf: [
                  { required: ['query'] },
                  { required: ['filters'] },
                  { required: ['result_level'] },
                  { required: ['video_ids'] },
                  { required: ['prompt_run_ids'] },
                  { required: ['index_id'] },
                  { required: ['index_name'] },
                  { required: ['limit'] },
                  { required: ['idempotency_key'] },
                ],
              },
            },
          ],
        },
      ],
    },
  },

  // --------------------------------------------------------------------------
  // Search Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.SEARCH_VIDEOS,
    description: `Search for video segments using natural language. Returns relevant clips with timestamps, thumbnails, and extracted metadata.

Use this tool when the user wants to:
- Find specific content, moments, or topics in their video library
- Search for scenes matching a description
- Locate videos containing certain objects, actions, or concepts

The search uses semantic similarity, so natural language queries work best.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query describing what to find',
        },
        index_id: {
          type: 'string',
          description:
            'ID of the index to search. Use list_indexes first to discover available indexes.',
        },
        top_k: {
          type: 'number',
          default: 10,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results to return (1-100)',
        },
        search_fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific metadata fields to search (e.g., ["description", "objects"]). If not provided, searches all fields.',
        },
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Limit search to specific prompt run IDs. If not provided, searches across all runs.',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optionally search across multiple indexes. If provided, backend uses these IDs instead of index_id path context.',
        },
      },
      required: ['query', 'index_id'],
    },
  },
  {
    name: TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE,
    description: `Find video segments that are visually similar to a reference image.

Use this tool when the user has an image and wants to find similar content in their videos. The image must be provided as a base64-encoded string.

Returns segments ordered by visual similarity, including the matched frame timestamp.`,
    inputSchema: {
      type: 'object',
      properties: {
        image_data: {
          type: 'string',
          description:
            'Base64-encoded image data (without data URL prefix). Supports JPEG, PNG, WebP formats.',
        },
        index_id: {
          type: 'string',
          description: 'ID of the index to search',
        },
        top_k: {
          type: 'number',
          default: 10,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results to return (1-100)',
        },
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Limit search to specific prompt run IDs. If not provided, searches across all runs.',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optionally search across multiple indexes. If provided, backend uses these IDs instead of index_id path context.',
        },
      },
      required: ['image_data', 'index_id'],
    },
  },
  {
    name: TOOL_NAMES.MULTIMODAL_SEARCH,
    description: `Search using both text and image queries combined. Uses Reciprocal Rank Fusion (RRF) to merge results from both modalities.

Use this tool when the user wants to find content matching both:
- A text description (what the content is about)
- A visual reference (what it looks like)

You can adjust weights to prioritize text or image similarity.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'ID of the index to search',
        },
        text_query: {
          type: 'string',
          description: 'Text search query (at least one of text_query or image_data required)',
        },
        image_data: {
          type: 'string',
          description:
            'Base64-encoded image data (at least one of text_query or image_data required)',
        },
        text_weight: {
          type: 'number',
          default: 0.5,
          minimum: 0,
          maximum: 1,
          description: 'Weight for text search results (0-1). Must sum to 1.0 with image_weight.',
        },
        image_weight: {
          type: 'number',
          default: 0.5,
          minimum: 0,
          maximum: 1,
          description: 'Weight for image search results (0-1). Must sum to 1.0 with text_weight.',
        },
        top_k: {
          type: 'number',
          default: 10,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results to return (1-100)',
        },
        search_fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific metadata fields to search for text relevance (e.g., ["description", "objects"]).',
        },
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Limit search to specific prompt run IDs. If not provided, searches across all runs.',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optionally search across multiple indexes. If provided, backend uses these IDs instead of index_id path context.',
        },
      },
      required: ['index_id'],
    },
  },
  {
    name: TOOL_NAMES.FILTER_VIDEOS,
    description: `Filter video segments by metadata field values using exact matches, ranges, or contains queries.

Use this tool for precise filtering when:
- You need exact matches (e.g., object_type = "vehicle")
- You need numeric ranges (e.g., confidence > 0.8)
- You need to check if an array contains a value

Supports up to 4 filter conditions combined with AND logic.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'ID of the index to filter',
        },
        conditions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Metadata field name to filter on',
              },
              operator: {
                type: 'string',
                enum: [
                  'contains',
                  'ends_with',
                  'equals',
                  'greater_equal',
                  'greater_than',
                  'is_empty',
                  'is_not_empty',
                  'item_contains',
                  'item_equals',
                  'length_equals',
                  'length_greater',
                  'length_less',
                  'less_equal',
                  'less_than',
                  'starts_with',
                ],
                description: 'Canonical backend filter operator.',
              },
              value: {
                description: 'Value to compare against',
              },
              type: {
                type: 'string',
                enum: ['array', 'boolean', 'integer', 'number', 'string'],
                description: 'Backend filter value type.',
              },
            },
            required: ['field', 'operator', 'type'],
            additionalProperties: false,
            oneOf: FILTER_CONDITION_SCHEMA_VARIANTS,
          },
          description: 'Filter conditions (1-4 conditions, combined with AND)',
        },
        page_size: {
          type: 'number',
          default: 50,
          minimum: 1,
          maximum: 100,
          description: 'Number of results per page',
        },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from a previous filter_videos response.',
        },
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Limit filtering to specific prompt runs.',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optionally filter across multiple indexes. If provided, backend uses these IDs instead of index_id path context.',
        },
      },
      required: ['index_id', 'run_ids', 'conditions'],
      additionalProperties: false,
      },
    },

  // --------------------------------------------------------------------------
  // Discovery Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.LIST_INDEXES,
    description: `List all video indexes the user has access to.

Use this tool to discover available video collections before searching. Returns both user-created indexes and shared demo indexes.

Each index contains videos that have been processed with specific prompts, enabling semantic search across their content.`,
    inputSchema: {
      type: 'object',
      properties: {
        include_defaults: {
          type: 'boolean',
          default: true,
          description: 'Include shared demo indexes',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.GET_INDEX,
    description: `Get detailed information about a specific video index.

Returns the index name, creation date, and whether it's a shared demo index.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'ID of the index to retrieve',
        },
      },
      required: ['index_id'],
    },
  },
  {
    name: TOOL_NAMES.LIST_PROMPTS,
    description: `List available analysis prompts that can be used to process videos.

Prompts define what information to extract from videos (e.g., objects, actions, scenes). Each prompt has a JSON schema that defines the output structure.

Use this to discover what analysis capabilities are available before running process_media.`,
    inputSchema: {
      type: 'object',
      properties: {
        include_defaults: {
          type: 'boolean',
          default: true,
          description: 'Include system default prompts',
        },
        active_only: {
          type: 'boolean',
          default: true,
          description: 'Only return active prompts',
        },
      },
    },
  },

  // --------------------------------------------------------------------------
  // Video/Segment Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.GET_VIDEO,
    description: `Get detailed information about a specific video.

Returns video metadata including title, overall status, media type, duration_seconds, timestamps, and per-prompt-run segment processing snapshots (pending/processing/successful/failed).`,
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'ID of the video to retrieve',
        },
      },
      required: ['video_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_VIDEO_SEGMENTS,
    description: `Get all segments for a video with their extracted metadata.

Segments are time-based chunks of the video with associated metadata from prompt analysis. Use this after search to get full details about a video's content.`,
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'ID of the video',
        },
        run_id: {
          type: 'string',
          description: 'Specific prompt run ID to get results from',
        },
        latest_run: {
          type: 'boolean',
          default: false,
          description: 'Get results from the latest prompt run',
        },
        limit: {
          type: 'number',
          default: 50,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of segments to return',
        },
      },
      required: ['video_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Prompt Run Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.LIST_PROMPT_RUNS,
    description: `List prompt runs for the current user, a specific index, or a specific video.

Use this to discover prior prompt executions before drilling into status, results, video-level summaries, billing settlement, or failed segments.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'List prompt runs for a specific index. Cannot be combined with video_id.',
        },
        video_id: {
          type: 'string',
          description: 'List prompt runs that include a specific video. Cannot be combined with index_id.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description:
            'Optional maximum number of runs to return. User scope defaults to 200 and supports up to 200; index scope defaults to 50 and supports up to 100; video scope preserves full history when omitted.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor. Only supported when index_id is provided.',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.ESTIMATE_PROMPT_RUN,
    description: `Estimate the billing cost of a prompt run using the same configuration as execution.

This does not start processing. Video/audio targets must already have server-measured duration metadata; otherwise the backend returns a duration validation error. Use it before process_media when the user wants pricing or balance confirmation.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          description: 'ID of the prompt to estimate.',
        },
        target: {
          type: 'object',
          description: 'Target configuration with type=index|videos|playground.',
          properties: {
            type: {
              type: 'string',
              enum: ['index', 'videos', 'playground'],
            },
            index_id: {
              type: 'string',
              description: 'Required when target.type is index. Optional when target.type is videos.',
            },
            video_ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Required when target.type is videos.',
            },
          },
          required: ['type'],
        },
        video_segmentation_type: {
          type: 'string',
          enum: ['fixed', 'content_aware'],
          description: 'How to segment videos before extraction.',
        },
        video_segment_duration: {
          type: 'number',
          minimum: 1,
          maximum: 300,
          description: 'Required when video_segmentation_type is fixed.',
        },
        audio_segmentation_type: {
          type: 'string',
          enum: ['fixed', 'content_aware'],
          description: 'How to segment audio files.',
        },
        audio_segment_duration: {
          type: 'number',
          minimum: 1,
          maximum: 300,
          description: 'Required when audio_segmentation_type is fixed.',
        },
        processing_model: {
          type: 'string',
          description: 'Optional model override; omitted fields inherit the saved indexed execution settings.',
        },
        enable_transcription: {
          type: 'boolean',
          description: 'Enable transcription for videos and audio.',
        },
        enable_image_embedding: {
          type: 'boolean',
          description: 'Enable image embeddings for image-search workflows.',
        },
      },
      required: ['prompt_id', 'target'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_RUN_STATUS,
    description: `Check the status and progress of a prompt execution run.

- Overall status (pending, processing, completed, completed_with_failures, failed, cancelled)
- Progress counts (completed/partial/failed/cancelled media and segments)
- Billing settlement fields (billing_status, billing_error, billing_estimated_mt, billing_actual_mt)
- Any error messages

Use this to monitor async processing jobs started with process_media.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID returned from process_media',
        },
      },
      required: ['run_id'],
    },
  },
  {
    name: TOOL_NAMES.CANCEL_PROMPT_RUN,
    description: `Request cancellation for a prompt run.

Already-started videos may finish, but no new videos will start after the stop is observed. Returned run data includes billing_status and billing_error so callers can distinguish released reservations from pending settlement or billable partial cancellation.

Use this when the user wants to stop an in-flight run because intent changed.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID returned from process_media',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of the stop request.',
        },
      },
      required: ['run_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_RUN_RESULTS,
    description: `Show results from an existing prompt run, including an interactive video viewer in compatible clients.

Use the run and video the user just processed or referenced in this conversation; supply video_id when the request concerns one video. The viewer preloads that video's results, pauses its player, and displays formatted analysis with segment switching. When the viewer is shown, keep the accompanying reply brief instead of repeating its fields. In clients without a viewer, present the returned viewing and JSON links.

Defaults to both pages across the entire run. Optionally narrow to one video_id. Each page has its own cursor; choose view=filtered or unfiltered to advance one page independently. result_level=segment returns segment metadata; video returns media-level extraction. selection_summary distinguishes pending, ready (including zero matches), failed, and not_applicable. A null page is unrequested or unavailable. Poll get_prompt_run_status while processing; reading results never starts processing, reruns search, or consumes generation usage.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', minLength: 1, description: 'Run ID from process_media.' },
        result_level: { type: 'string', enum: ['segment', 'video'], default: 'segment' },
        video_id: { type: 'string', minLength: 1, description: 'Optionally narrow both pages to one media item.' },
        view: { type: 'string', enum: ['both', 'filtered', 'unfiltered'], default: 'both' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum rows in each requested page.' },
        filtered_cursor: { type: 'string', minLength: 1, description: 'Opaque next_cursor from the filtered page.' },
        unfiltered_cursor: { type: 'string', minLength: 1, description: 'Opaque next_cursor from the unfiltered page.' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT,
    description: `Get the video/audio-level extraction result for a specific media item inside a prompt run.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID.',
        },
        video_id: {
          type: 'string',
          description: 'The video or audio media ID within the run.',
        },
      },
      required: ['run_id', 'video_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_RUN_FAILED_SEGMENTS,
    description: `Get the failed segment manifest for a prompt run grouped by video and operation.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID.',
        },
      },
      required: ['run_id'],
    },
  },
  {
    name: TOOL_NAMES.RETRY_PROMPT_RUN_SEGMENT,
    description: `Retry a failed segment inside a completed prompt run without creating a new run.

Returns retry billing fields. Terminal retry states settle billing_status to confirmed or released unless billing_error indicates an unresolved owner-aware billing operation.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID.',
        },
        video_id: {
          type: 'string',
          description: 'The parent media ID.',
        },
        segment_id: {
          type: 'string',
          description: 'The failed segment ID to retry.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry dispatch.',
        },
      },
      required: ['run_id', 'video_id', 'segment_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_RUN_SEGMENT_RETRY_STATUS,
    description: `Get the status of an async prompt-run segment retry.

Includes billing_status and billing_error for retry reservation settlement.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The prompt run ID.',
        },
        video_id: {
          type: 'string',
          description: 'The parent media ID.',
        },
        segment_id: {
          type: 'string',
          description: 'The retried segment ID.',
        },
        retry_id: {
          type: 'string',
          description: 'The retry ID returned by retry_prompt_run_segment.',
        },
      },
      required: ['run_id', 'video_id', 'segment_id', 'retry_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Prompt Management Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.CREATE_PROMPT,
    description: `Create a new custom extraction prompt with a JSON schema.

Prompts define what information to extract from video segments. The JSON schema specifies the structure of extracted metadata.

Use this tool when the user wants to:
- Define custom metadata fields to extract from videos
- Create a new analysis template for their specific use case
- Set up structured data extraction for their video library

The prompt_text is the instruction given to the AI model during extraction.
The json_schema must be a valid JSON Schema with root type "object".`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 3,
          maxLength: 100,
          description: 'A descriptive name for the prompt (3-100 characters)',
        },
        description: {
          type: 'string',
          maxLength: 500,
          description: 'Optional description of what this prompt extracts',
        },
        prompt_text: {
          type: 'string',
          minLength: 10,
          maxLength: 5000,
          description: 'The instruction text given to the AI model for extraction (10-5000 characters)',
        },
        json_schema: {
          type: 'object',
          description: 'JSON Schema defining the structure of extracted metadata.',
        },
        video_level: {
          type: 'object',
          description: 'Optional grounded video/audio-level extraction in the same content-aware model call. Each standalone part is analyzed independently.',
          properties: {
            instructions_text: {
              type: 'string',
              minLength: 1,
              maxLength: 12000,
            },
            json_schema: {
              type: 'object',
            },
          },
          required: ['instructions_text', 'json_schema'],
        },
        semantic_indexing: {
          type: 'object',
          description: 'Optional indexing controls for disabling specific segment or video-level fields.',
          properties: {
            disabled_segment_fields: {
              type: 'array',
              items: { type: 'string' },
            },
            disabled_video_level_fields: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        execution_config: {
          type: 'object',
          properties: EXECUTION_CONFIGURATION_PROPERTIES,
          additionalProperties: false,
          description: 'Saved execution defaults. Omitted run overrides inherit this configuration for indexed media.',
        },
        selection_filter: SELECTION_FILTER_SCHEMA,
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of prompt creation.',
        },
      },
      required: ['name', 'prompt_text', 'json_schema'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT,
    description: `Get detailed information about a specific prompt including its full JSON schema.

Returns the complete prompt definition with:
- The prompt text (AI instruction)
- Full JSON schema for extraction
- Active status and creation date

Use this to understand what a prompt extracts before using it with process_media.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          description: 'ID of the prompt to retrieve. Use list_prompts to discover available prompts.',
        },
      },
      required: ['prompt_id'],
    },
  },
  {
    name: TOOL_NAMES.UPDATE_PROMPT,
    description: `Update an existing prompt's name, instructions, schemas, or video-level extraction settings.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          description: 'ID of the prompt to update',
        },
        name: {
          type: 'string',
          minLength: 3,
          maxLength: 100,
          description: 'New name for the prompt (optional)',
        },
        description: {
          type: 'string',
          maxLength: 500,
          description: 'New description for the prompt (optional)',
        },
        prompt_text: {
          type: 'string',
          minLength: 10,
          maxLength: 5000,
          description: 'Updated prompt instructions.',
        },
        json_schema: {
          type: 'object',
          description: 'Updated JSON schema for segment extraction.',
        },
        video_level: {
          type: 'object',
          description: 'Replacement grounded video/audio-level extraction in the same content-aware model call. Each standalone part is analyzed independently.',
          properties: {
            instructions_text: {
              type: 'string',
              minLength: 1,
              maxLength: 12000,
            },
            json_schema: {
              type: 'object',
            },
          },
          required: ['instructions_text', 'json_schema'],
        },
        semantic_indexing: {
          type: 'object',
          description: 'Replacement semantic indexing controls.',
          properties: {
            disabled_segment_fields: {
              type: 'array',
              items: { type: 'string' },
            },
            disabled_video_level_fields: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        clear_video_level: {
          type: 'boolean',
          default: false,
          description: 'Remove any existing grounded video/audio-level extraction in the same content-aware model call. Each standalone part is analyzed independently.',
        },
        execution_config: {
          type: 'object',
          properties: EXECUTION_CONFIGURATION_PROPERTIES,
          additionalProperties: false,
          description: 'Saved execution defaults. Omitted run overrides inherit this configuration for indexed media.',
        },
        selection_filter: SELECTION_FILTER_SCHEMA,
        clear_selection_filter: { type: 'boolean', default: false, description: 'Remove the saved selection filter.' },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of prompt updates.',
        },
      },
      required: ['prompt_id'],
    },
  },
  {
    name: TOOL_NAMES.TEST_PROMPT_SCHEMA,
    description: `Validate prompt JSON schema behavior against sample data using the backend schema validator.`,
    inputSchema: {
      type: 'object',
      properties: {
        json_schema: {
          type: 'object',
          description: 'The JSON schema to validate.',
        },
        sample_data: {
          type: 'object',
          description: 'Sample payload to validate against the schema.',
        },
      },
      required: ['json_schema', 'sample_data'],
    },
  },
  {
    name: TOOL_NAMES.GET_PROMPT_USAGE,
    description: `Get usage statistics for a prompt, including whether it is active and still in use.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          description: 'The prompt ID.',
        },
      },
      required: ['prompt_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Cloud Connector Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.CREATE_GCS_CONNECTOR,
    description: `Create a Google Cloud Storage (GCS) connector for importing videos from cloud storage.

Requires a GCP service account with read access to the bucket. The credentials must be a valid service account key JSON.

After creating a connector, use test_connector to verify the connection and browse_connector_files to explore available files.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'A descriptive name for this connector',
        },
        bucket: {
          type: 'string',
          description: 'GCS bucket name (e.g., "my-video-bucket")',
        },
        gcp_project_id: {
          type: 'string',
          description: 'Google Cloud project ID that owns the bucket',
        },
        credentials_json: {
          type: 'object',
          description: 'Service account key JSON object with fields like project_id, private_key, client_email, etc.',
        },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['import', 'export'] },
          default: ['import'],
          description: 'Connector scopes: import and/or export.',
        },
        export_base_path: {
          type: 'string',
          description: 'Base prefix allowed for export destination paths when export scope is enabled.',
        },
        import_mode: {
          type: 'string',
          enum: ['all', 'new_only'],
          default: 'all',
          description: 'Import dedupe behavior: all files or only new files.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Required stable idempotency key for safe retry of connector creation.',
        },
      },
      required: ['name', 'bucket', 'gcp_project_id', 'credentials_json', 'idempotency_key'],
    },
  },
  {
    name: TOOL_NAMES.CREATE_S3_CONNECTOR,
    description: `Create an Amazon S3 connector for importing videos from AWS cloud storage.

Requires AWS credentials with read access to the bucket (s3:GetObject, s3:ListBucket permissions).

After creating a connector, use test_connector to verify the connection and browse_connector_files to explore available files.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'A descriptive name for this connector',
        },
        bucket: {
          type: 'string',
          description: 'S3 bucket name',
        },
        region: {
          type: 'string',
          description: 'AWS region (e.g., "us-east-1", "eu-west-1")',
        },
        aws_access_key_id: {
          type: 'string',
          description: 'AWS access key ID',
        },
        aws_secret_access_key: {
          type: 'string',
          description: 'AWS secret access key',
        },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['import', 'export'] },
          default: ['import'],
          description: 'Connector scopes: import and/or export.',
        },
        export_base_path: {
          type: 'string',
          description: 'Base prefix allowed for export destination paths when export scope is enabled.',
        },
        import_mode: {
          type: 'string',
          enum: ['all', 'new_only'],
          default: 'all',
          description: 'Import dedupe behavior: all files or only new files.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Required stable idempotency key for safe retry of connector creation.',
        },
      },
      required: [
        'name',
        'bucket',
        'region',
        'aws_access_key_id',
        'aws_secret_access_key',
        'idempotency_key',
      ],
    },
  },
  {
    name: TOOL_NAMES.CREATE_AZURE_CONNECTOR,
    description: `Create an Azure Blob Storage connector for importing videos from Azure cloud storage.

Requires an Azure service principal with Storage Blob Data Reader role on the container.

After creating a connector, use test_connector to verify the connection and browse_connector_files to explore available files.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'A descriptive name for this connector',
        },
        storage_account: {
          type: 'string',
          description: 'Azure storage account name',
        },
        container: {
          type: 'string',
          description: 'Azure blob container name',
        },
        tenant_id: {
          type: 'string',
          description: 'Azure Active Directory tenant ID',
        },
        client_id: {
          type: 'string',
          description: 'Azure service principal client ID (application ID)',
        },
        client_secret: {
          type: 'string',
          description: 'Azure service principal client secret',
        },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['import', 'export'] },
          default: ['import'],
          description: 'Connector scopes: import and/or export.',
        },
        export_base_path: {
          type: 'string',
          description: 'Base prefix allowed for export destination paths when export scope is enabled.',
        },
        import_mode: {
          type: 'string',
          enum: ['all', 'new_only'],
          default: 'all',
          description: 'Import dedupe behavior: all files or only new files.',
        },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          description: 'Required stable idempotency key for safe retry of connector creation.',
        },
      },
      required: [
        'name',
        'storage_account',
        'container',
        'tenant_id',
        'client_id',
        'client_secret',
        'idempotency_key',
      ],
    },
  },
  {
    name: TOOL_NAMES.LIST_CONNECTORS,
    description: `List all cloud storage connectors configured for the user.

Returns connectors for all providers (GCS, S3, Azure) with their status and configuration details.

Use this to discover available connectors before importing files.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.TEST_CONNECTOR,
    description: `Test a cloud connector's connection to verify credentials and access.

Returns success/failure with error details if the connection fails. Use this after creating a connector or to diagnose connection issues.`,
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'ID of the connector to test. Use list_connectors to find connector IDs.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for replaying one exact connector probe.',
        },
      },
      required: ['connector_id'],
    },
  },
  {
    name: TOOL_NAMES.BROWSE_CONNECTOR_FILES,
    description: `Browse files in a cloud storage connector.

Returns a list of files matching the specified prefix and pattern. Use this to discover available video files before creating an import job.

Supports glob patterns for filtering (e.g., "*.mp4", "videos/*.mov").`,
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'ID of the connector to browse',
        },
        prefix: {
          type: 'string',
          default: '',
          description: 'Path prefix to filter files (e.g., "videos/2024/")',
        },
        pattern: {
          type: 'string',
          default: '*',
          description: 'Glob pattern to match filenames (e.g., "*.mp4", "*.{mp4,mov}")',
        },
        recursive: {
          type: 'boolean',
          default: true,
          description: 'Include files in subdirectories',
        },
      },
      required: ['connector_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Import Job Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.CREATE_IMPORT_JOB,
    description: `Create and start an import job to bring files from a cloud connector into an index.

This starts an asynchronous job that imports video/audio/image files from your cloud storage (GCS, S3, or Azure) into a VideoVector index.

Use browse_connector_files first to discover available files, then create an import job with the desired prefix and pattern.

Returns immediately with a job_id. Use get_import_job to check progress.`,
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'ID of the cloud connector to import from. Use list_connectors to find available connectors.',
        },
        index_id: {
          type: 'string',
          description: 'Target index ID where imported videos will appear. Use list_indexes or create_index.',
        },
        source_prefix: {
          type: 'string',
          default: '',
          description: 'Path prefix in source storage (e.g., "videos/2024/")',
        },
        file_pattern: {
          type: 'string',
          default: '*',
          description: 'Glob pattern for files to import (e.g., "*.mp4", "*.{mp4,mov,avi}")',
        },
        recursive: {
          type: 'boolean',
          default: true,
          description: 'Include files in subdirectories',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of import-job creation.',
        },
      },
      required: ['connector_id', 'index_id'],
    },
  },
  {
    name: TOOL_NAMES.LIST_IMPORT_JOBS,
    description: `List all import jobs for the user.

Returns jobs with their status, progress, and results. Use this to monitor ongoing imports or review past import history.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'scanning', 'importing', 'completed', 'failed', 'cancelled'],
          description: 'Filter jobs by status (optional)',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.GET_IMPORT_JOB,
    description: `Get detailed status and progress of a specific import job.

Returns:
- Current status (pending, scanning, importing, completed, failed, cancelled)
- Phase and source-file progress (total files, imported, failed, skipped, bytes transferred), with separate part counters
- Ordered outputs page with source/part positions and original time ranges; video_ids includes only that page. Follow outputs.next_cursor until null, or use import_job_id with process_media to select the entire completed import.
- run_id once a find workflow has submitted its execution; then use get_prompt_run_status and get_prompt_run_results
- Failed source details; follow failed_files_next_cursor using failed_files_cursor to inspect every failure before retrying`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'ID of the import job. Use list_import_jobs to find job IDs.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        cursor: { type: 'string', description: 'Opaque outputs.next_cursor from the previous page. Continue until null to enumerate every standalone part.' },
        failed_files_cursor: { type: 'string', description: 'Opaque failed_files_next_cursor. Returns the next page of failed source descriptors for inspection or refresh.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: TOOL_NAMES.RETRY_IMPORT_JOB,
    _meta: { 'openai/fileParams': ['files'] },
    description: 'Resume a failed attachment import or find workflow, reusing imported and staged files. If get_import_job reports refresh_required, supply fresh host descriptors in files for those same unfinished file IDs; keep original file_name and mime_type. Use a new idempotency key when changing descriptors. A known wizard failure starts a new generation attempt; successful generations are reused. An uncertain generation outcome returns a conflict. This resumes the same job. Use find for a fresh command instead.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', minLength: 1 },
        files: ATTACHMENT_FILES_SCHEMA,
        idempotency_key: { type: 'string', minLength: 1 },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.CANCEL_IMPORT_JOB,
    description: `Cancel a running import job.

Files already imported will remain in the index. Only pending files will be skipped.

Failed attachment jobs may also be cancelled to discard retained unfinished files. Completed jobs, cancelled jobs, and failed connector jobs cannot be cancelled.`,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'ID of the import job to cancel',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of import-job cancellation.',
        },
      },
      required: ['job_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Index Management Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.CREATE_INDEX,
    description: `Create a new video index.

Indexes are collections that hold videos and their processed metadata. Create an index before uploading videos or running imports.

After creating an index, you can:
- Import videos from cloud storage using create_import_job
- Run prompts on the index using process_media
- Search the index using search_videos`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description: 'Name for the new index (1-255 characters)',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of index creation.',
        },
      },
      required: ['name'],
    },
  },

  // --------------------------------------------------------------------------
  // Video Management Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.LIST_VIDEOS,
    description: `List videos in an index with pagination.

Returns video metadata including title, overall status, and run-based segment processing summaries (without loading segment payloads), plus media type and timestamps. Use this to browse the contents of an index.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'ID of the index to list videos from',
        },
        limit: {
          type: 'number',
          default: 50,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of videos to return (1-100)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response for next page',
        },
      },
      required: ['index_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_VIDEOS_STATUS,
    description: `Get processing status for multiple videos at once.

Efficiently check the processing state of up to 100 videos in a single call. Returns both overall video status and run-based segment status snapshots for each video.

Use this to monitor video processing progress after imports or uploads.`,
    inputSchema: {
      type: 'object',
      properties: {
        video_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 100,
          description: 'List of video IDs to check status for (1-100 videos)',
        },
      },
      required: ['video_ids'],
    },
  },

  // --------------------------------------------------------------------------
  // Export Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.EXPORT_INDEX_METADATA,
    description: `Export all extracted metadata from an index to a downloadable file.

Creates an asynchronous export job that compiles all video segments and their extracted metadata into a JSON file.

Optionally filter to specific prompt runs. Returns immediately with an export_id - use get_export_status to check when the file is ready.`,
    inputSchema: {
      type: 'object',
      properties: {
        index_id: {
          type: 'string',
          description: 'ID of the index to export',
        },
        prompt_run_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific prompt run IDs to include. If not provided, exports all runs.',
        },
        destination_connector_id: {
          type: 'string',
          description: 'Optional connector ID for cloud-destination export instead of a downloadable file.',
        },
        destination_subpath: {
          type: 'string',
          description: 'Optional sub-prefix under the connector export base path.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of export creation.',
        },
      },
      required: ['index_id'],
    },
  },
  {
    name: TOOL_NAMES.EXPORT_PROMPT_RUN,
    description: `Export metadata from a specific prompt run to a downloadable file.

Creates an asynchronous export job for the results of a single prompt execution. Returns immediately with an export_id - use get_export_status to check when the file is ready.`,
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'ID of the prompt run to export',
        },
        destination_connector_id: {
          type: 'string',
          description: 'Optional connector ID for cloud-destination export instead of a downloadable file.',
        },
        destination_subpath: {
          type: 'string',
          description: 'Optional sub-prefix under the connector export base path.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of export creation.',
        },
      },
      required: ['run_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_EXPORT_STATUS,
    description: `Get the status and delivery details of an export job.

Returns:
- status: pending, processing, completed, or failed
- destination_type: download or connector
- destination_connector_id and destination_uri: connector delivery details when applicable
- links.open_in_app: account-protected app link to review this export
- links.download_json: clickable app download link when a direct export is ready
- download_url: authenticated API download endpoint for a completed direct export
- file_size_bytes: size of the exported file
- error_message: details if the export failed

This tool is side-effect free and never creates or returns a bearer capability.
Present links.download_json to users for a ready download, or links.open_in_app
to review status. These links use the user's existing VideoVector sign-in.
The legacy download_url path is for authenticated SDK/API streaming clients.`,
    inputSchema: {
      type: 'object',
      properties: {
        export_id: {
          type: 'string',
          description: 'ID of the export job to check',
        },
      },
      required: ['export_id'],
    },
  },
  {
    name: TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL,
    description: `Explicitly mint a bounded bearer URL for one owned export.

Returns exactly:
- export_id
- status
- destination_type: download or connector
- destination_connector_id
- download_url: short-lived bearer URL, or null when not downloadable

This operation creates a fresh bearer capability and is not idempotent. It
returns download_url=null for processing, failed, connector-delivered, and
otherwise unavailable exports. Treat any non-null URL as sensitive: do not log,
persist, or share it beyond the intended client. Prefer authenticated SDK/API
streaming for large files instead of loading export content into MCP context.`,
    inputSchema: {
      type: 'object',
      properties: {
        export_id: {
          type: 'string',
          description: 'ID of the owned export for which to mint a bounded URL',
        },
      },
      required: ['export_id'],
    },
  },

  // --------------------------------------------------------------------------
  // Webhook Tools
  // --------------------------------------------------------------------------
  {
    name: TOOL_NAMES.CREATE_WEBHOOK,
    description: `Create a webhook to receive real-time notifications for events.

Webhooks send HTTP POST requests to your endpoint when events occur (e.g., video processing completed, prompt run finished).

The URL must use HTTPS. A signing secret is returned once at creation - store it securely to verify webhook signatures.

Use list_webhook_events first to see available event types.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Human-readable name for the webhook',
        },
        url: {
          type: 'string',
          description: 'Target endpoint URL (must be HTTPS)',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Event types to subscribe to. Use list_webhook_events to see available events.',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to specific indexes (optional, omit for all indexes)',
        },
        metadata: {
          type: 'object',
          description: 'Custom metadata to include with each delivery (optional)',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of webhook creation.',
        },
      },
      required: ['name', 'url', 'events'],
    },
  },
  {
    name: TOOL_NAMES.LIST_WEBHOOKS,
    description: `List all webhooks configured for the user.

Returns webhook configurations including their status, subscribed events, and failure counts.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.GET_WEBHOOK,
    description: `Get detailed information about a specific webhook.

Returns the full webhook configuration including events, status, and delivery statistics.`,
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: {
          type: 'string',
          description: 'ID of the webhook to retrieve',
        },
      },
      required: ['webhook_id'],
    },
  },
  {
    name: TOOL_NAMES.UPDATE_WEBHOOK,
    description: `Update a webhook's configuration.

Can update the name, URL, subscribed events, index filters, status (active/paused), or metadata.

At least one field must be provided.`,
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: {
          type: 'string',
          description: 'ID of the webhook to update',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'New name for the webhook',
        },
        url: {
          type: 'string',
          description: 'New target URL (must be HTTPS)',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'New list of event types to subscribe to',
        },
        index_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of index IDs to filter to',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'Set webhook status (active or paused)',
        },
        metadata: {
          type: 'object',
          description: 'New custom metadata',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of webhook updates.',
        },
      },
      required: ['webhook_id'],
    },
  },
  {
    name: TOOL_NAMES.LIST_WEBHOOK_EVENTS,
    description: `List all supported webhook event types.

Returns the available events you can subscribe to when creating or updating webhooks.

Common events include:
- media.processing.completed - Video/audio/image finished processing
- prompt_run.completed / prompt_run.cancelled - Prompt execution reached a terminal state
- import_job.completed - Import job finished`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: TOOL_NAMES.TEST_WEBHOOK,
    description: `Send a test event to verify webhook configuration.

Sends a test payload to the webhook URL to verify it's reachable and correctly configured.

Returns success/failure with the HTTP status code or error message.`,
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: {
          type: 'string',
          description: 'ID of the webhook to test',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key for safe retry of webhook test dispatch.',
        },
      },
      required: ['webhook_id'],
    },
  },
  {
    name: TOOL_NAMES.LIST_WEBHOOK_DELIVERIES,
    description: `List delivery attempts for a webhook.

Returns the history of webhook deliveries including status, attempts, response codes, and any errors.

Use this to debug webhook issues or verify events are being delivered.`,
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: {
          type: 'string',
          description: 'ID of the webhook to get deliveries for',
        },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'delivered', 'failed', 'retrying'],
          description: 'Filter by delivery status (optional)',
        },
        limit: {
          type: 'number',
          default: 50,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of deliveries to return',
        },
      },
      required: ['webhook_id'],
    },
  },
];

export const TOOL_DEFINITIONS: Tool[] = BASE_TOOL_DEFINITIONS.map((tool) => {
  const toolName = tool.name as ToolName;
  const outputSchema = WORKFLOW_RESULT_TOOLS.has(toolName) ? WORKFLOW_RESULT_SCHEMA : TOOL_OUTPUT_SCHEMAS[toolName];
  return {
    ...tool,
    ...(WORKFLOW_DETAIL_TOOLS.has(toolName) ? {
      description: `${tool.description}\n\nReturns compact contract_version=2 summaries by default. Use detail=full only when the user asks to inspect extracted JSON or prompt details. Pagination is identical in both modes. Open returned app links for playback and JSON downloads without adding payloads to model context.`,
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, detail: { type: 'string', enum: ['summary', 'full'], default: 'summary' } } },
    } : {}),
    ...(['get_prompt_run_results', 'search_media'].includes(toolName) ? {
      _meta: { ...tool._meta, ui: { resourceUri: RESULTS_CARD_URI }, 'openai/outputTemplate': RESULTS_CARD_URI, 'openai/widgetAccessible': true },
    } : {}),
    title: TOOL_TITLES[toolName],
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: getToolAnnotations(tool.name),
  };
});

export type ToolProfile = 'simple' | 'full';
export type ToolTransport = 'stdio' | 'streamable-http';

export interface ToolAvailability {
  profiles: ToolProfile[];
  transports: ToolTransport[];
}

const SIMPLE_TOOL_NAMES = new Set<string>([
  TOOL_NAMES.UPLOAD_MEDIA,
  TOOL_NAMES.FIND,
  TOOL_NAMES.DEFINE_PROMPT,
  TOOL_NAMES.PROCESS_MEDIA,
  TOOL_NAMES.SEARCH_MEDIA,
  TOOL_NAMES.GET_PROMPT_RUN_STATUS,
  TOOL_NAMES.GET_PROMPT_RUN_RESULTS,
  TOOL_NAMES.GET_IMPORT_JOB,
  TOOL_NAMES.RETRY_IMPORT_JOB,
]);

// OpenAI's public MCP contract must not ask the model to collect credentials
// or return bearer capabilities. These tools remain available to the existing
// stdio and HTTP API-key surfaces; only the advertised OAuth publication clone
// excludes them.
const OAUTH_PUBLICATION_UNSAFE_TOOLS = new Set<string>([
  TOOL_NAMES.CREATE_GCS_CONNECTOR,
  TOOL_NAMES.CREATE_S3_CONNECTOR,
  TOOL_NAMES.CREATE_AZURE_CONNECTOR,
  TOOL_NAMES.CREATE_WEBHOOK,
  TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL,
]);

export const SIMPLE_TOOL_DEFINITIONS: Tool[] = TOOL_DEFINITIONS.filter((tool) =>
  SIMPLE_TOOL_NAMES.has(tool.name)
);

export function getToolAvailability(name: string): ToolAvailability {
  return {
    profiles: SIMPLE_TOOL_NAMES.has(name) ? ['simple', 'full'] : ['full'],
    transports: ['stdio', 'streamable-http'],
  };
}

/**
 * Select the runtime tool surface. The full profile is the compatibility
 * default; local path shortcuts are removed for every non-stdio transport.
 */
export function getToolDefinitions(
  profile: ToolProfile = 'full',
  includeLocalUpload: boolean = true,
  options: ToolDefinitionOptions = {}
): Tool[] {
  const selected = [...(profile === 'simple' ? SIMPLE_TOOL_DEFINITIONS : TOOL_DEFINITIONS), ...(options.includeAppTools ? RESULTS_APP_DEFINITIONS : [])];
  const transportTools = includeLocalUpload
    ? selected
    : selected.map((tool) => {
      if (tool.name !== TOOL_NAMES.UPLOAD_MEDIA && tool.name !== TOOL_NAMES.FIND) return tool;
      const properties = { ...tool.inputSchema.properties };
      delete properties.file_path;
      delete properties.file_paths;
      return {
        ...tool,
        inputSchema: {
          type: 'object' as const,
          properties,
          additionalProperties: false,
          ...(tool.name === TOOL_NAMES.FIND
            ? { required: ['instruction'] }
            : { not: { required: ['index_id', 'index_name'] } }),
        },
      };
    });
  if (!options.advertiseOAuth) {
    return transportTools;
  }
  const publicationTools = transportTools.filter(
    (tool) => !OAUTH_PUBLICATION_UNSAFE_TOOLS.has(tool.name)
  );
  return publicationTools.map((tool): OAuthAdvertisedTool => {
    const securitySchemes: OAuth2SecurityScheme[] = [{ type: 'oauth2', scopes: [] }];
    return {
      ...tool,
      securitySchemes,
      _meta: {
        ...tool._meta,
        securitySchemes: securitySchemes.map((scheme) => ({
          ...scheme,
          scopes: [...scheme.scopes],
        })),
      },
    };
  });
}

// ============================================================================
// Helper to get tool by name
// ============================================================================

export function getToolDefinition(name: string): Tool | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? RESULTS_APP_DEFINITIONS.find((tool) => tool.name === name);
}
