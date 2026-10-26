/** The single model-facing catalog. Native REST client methods are independent. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MAX_ATTACHMENT_FILES } from '../attachments/limits.js';
import { ANALYSIS_RESULT_SCHEMA, WORKFLOW_RESULT_SCHEMA } from './workflow-result-contract.js';

export const ATTACHMENT_FILES_SCHEMA = {
  type: 'array', minItems: 1, maxItems: MAX_ATTACHMENT_FILES,
  description: 'Native chat attachments supplied by the host; pass descriptors unchanged. Their temporary authorized HTTPS URLs do not require public publishing. At most eight files, each at most 2 GiB.',
  items: { type: 'object', properties: {
    download_url: { type: 'string', minLength: 1, format: 'uri', pattern: '^https://', description: 'Host-provided temporary authorized download URL, not a local or sandbox path. Do not invent or publicly publish a URL.' }, file_id: { type: 'string', minLength: 1 },
    mime_type: { type: 'string' }, file_name: { type: 'string' },
  }, required: ['download_url', 'file_id'], additionalProperties: false },
};
export const TOOL_NAMES = { ANALYZE: 'analyze', GET_ANALYSIS: 'get_analysis', SEARCH: 'search', IMPORT_MEDIA: 'import_media', SAVE_PROMPT: 'save_prompt', BROWSE: 'browse' } as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
export type ToolRequiredScope = 'read' | 'write' | 'search';
export type ToolTransport = 'stdio' | 'streamable-http';
export interface ToolAvailability { transports: ToolTransport[]; }
export interface ToolDefinitionOptions { advertiseOAuth?: boolean; includeLocalUpload?: boolean; }
type Schema = Record<string, unknown>;
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: string };
const detail = { type: 'string', enum: ['summary', 'full'], default: 'summary', description: 'Prefer summary and the complete JSON download; full is a bounded inline fallback.' };
const key = { ...string, description: 'Reuse the same key and identical arguments after uncertain submission; new work uses a new key.' };
const wait = { type: 'integer', minimum: 0, maximum: 30, default: 30, description: 'Maximum observation time, not processing duration. Processing continues after this call ends.' };
const pageSize = { type: 'integer', minimum: 1, maximum: 50, default: 20 };
const object = (properties: Record<string, unknown>, required: string[] = []): Schema & { type: 'object' } => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const oneSelector = (names: string[]): Schema => ({ oneOf: names.map(name => ({ required: [name] })) });
const excludes = (...names: string[]): Schema => ({ not: { anyOf: names.map(name => ({ required: [name] })) } });
const destination = { ...object({ index_id: string, index_name: string }), ...oneSelector(['index_id', 'index_name']), description: 'Destination for new media only. Name creates or reuses an index; omit for Playground.' };
const webhook = { ...object({ url: { type: 'string', format: 'uri', pattern: '^https://' }, signing_secret: { type: 'string', minLength: 16, maxLength: 256, writeOnly: true, description: 'Caller-provided verification secret; never include it in results or logs.' } }, ['url', 'signing_secret']), description: 'Direct integrations only. One terminal notification for this task; no account-wide subscription.' };
const connector = { ...object({ provider: { type: 'string', enum: ['gcs', 's3', 'azure'] }, name: string, config: { type: 'object' } }, ['provider', 'config']), oneOf: [
  { properties: { provider: { const: 'gcs' }, config: object({ bucket: string, gcp_project_id: string, credentials_json: { type: 'object', additionalProperties: true, writeOnly: true } }, ['bucket', 'gcp_project_id', 'credentials_json']) } },
  { properties: { provider: { const: 's3' }, config: object({ bucket: string, region: string, aws_access_key_id: { ...string, writeOnly: true }, aws_secret_access_key: { ...string, writeOnly: true } }, ['bucket', 'region', 'aws_access_key_id', 'aws_secret_access_key']) } },
  { properties: { provider: { const: 'azure' }, config: object({ storage_account: string, container: string, tenant_id: string, client_id: string, client_secret: { ...string, writeOnly: true } }, ['storage_account', 'container', 'tenant_id', 'client_id', 'client_secret']) } },
] };
function sourceSchema(analysis: boolean, options: ToolDefinitionOptions = {}): Schema {
  const selectors: Record<string, unknown> = {
    ...(options.includeLocalUpload === false ? {} : { file_paths: { type: 'array', minItems: 1, maxItems: MAX_ATTACHMENT_FILES, items: string, description: 'Local stdio paths within configured upload roots.' } }),
    ...(options.advertiseOAuth ? {} : { connector_id: string, connector }),
    ...(analysis ? { video_ids: ids, index_id: string, index_name: string, playground: { const: true, type: 'boolean' }, import_id: string } : {}),
  };
  const cloud = options.advertiseOAuth ? {} : { prefix: { type: 'string' }, pattern: string, recursive: { type: 'boolean', default: true } };
  return { ...object({ ...selectors, ...cloud }), ...oneSelector(Object.keys(selectors)),
    ...(options.advertiseOAuth ? {} : { allOf: [
      { if: { anyOf: ['prefix', 'pattern', 'recursive'].map(name => ({ required: [name] })) }, then: { anyOf: [{ required: ['connector_id'] }, { required: ['connector'] }] } },
    ] }),
  };
}
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


const searchFilters = { type: 'array', minItems: 1, maxItems: 4, items: {
  ...object({ field: string, operator: { type: 'string', enum: ['equals', 'greater_than', 'greater_equal', 'less_than', 'less_equal', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty', 'item_equals', 'item_contains', 'length_equals', 'length_greater', 'length_less'], default: 'equals' }, value: {} }, ['field']),
  if: { required: ['operator'], properties: { operator: { enum: ['is_empty', 'is_not_empty'] } } }, then: excludes('value'), else: { required: ['value'] },
} };
const promptDefinition = { ...object({ name: string, description: { type: ['string', 'null'] }, prompt_text: string, json_schema: { type: 'object', additionalProperties: true },
  video_level: { ...object({ instructions_text: { ...string, maxLength: 12000 }, json_schema: { type: 'object', additionalProperties: true } }, ['instructions_text', 'json_schema']), type: ['object', 'null'] }, semantic_indexing: { ...object({ disabled_segment_fields: { type: 'array', uniqueItems: true, items: string }, disabled_video_level_fields: { type: 'array', uniqueItems: true, items: string } }), type: ['object', 'null'] },
  execution_config: object(EXECUTION_CONFIGURATION_PROPERTIES), selection_filter: SELECTION_FILTER_SCHEMA,
}, ['name', 'prompt_text', 'json_schema']) };
const browseFields: Record<string, string[]> = {
  indexes: ['ids', 'name'], videos: ['ids', 'name', 'index_id', 'index_name'],
  analyses: ['ids', 'index_id', 'index_name', 'video_ids', 'status'],
  imports: ['ids', 'index_id', 'index_name', 'status'], prompts: ['ids', 'name', 'include_defaults', 'active_only'],
};
const browseSelectors = ['ids', 'name', 'index_id', 'index_name', 'video_ids', 'status', 'include_defaults', 'active_only'];
const nextAction = { type: 'object', properties: { type: string }, required: ['type'], additionalProperties: true };
const importResultSchema: NonNullable<Tool['outputSchema']> = {
  ...object({ import_id: string, analysis_id: string, status: string, stage: string, message: string, scope: {type:'object'}, progress:{type:'object'},
    results:{type:'object'},files:{type:'object'},failures:{type:'object'},errors:{type:'array',items:{type:'object'}},next_action:nextAction,
  }, ['import_id','status','stage','progress','results','next_action']),
};
const promptResultSchema: NonNullable<Tool['outputSchema']> = {
  ...object({ saved:{type:'boolean'},prompt_id:string,prompt:{type:'object'},definition:promptDefinition,next_action:nextAction }, ['saved','next_action']),
};
const browseResultSchema: NonNullable<Tool['outputSchema']> = {
  ...object({ resource:{type:'string',enum:Object.keys(browseFields)},entries:{type:'array',items:{type:'object'}},pagination:{type:'object'},next_action:nextAction }, ['resource','entries','pagination','next_action']),
};

function definitions(options: ToolDefinitionOptions = {}): Tool[] {
  const oauth = options.advertiseOAuth === true;
  const source = sourceSchema(true, options);
  const importSource = sourceSchema(false, options);
  const intakeProperties = {
    files: ATTACHMENT_FILES_SCHEMA,
    ...(Object.keys((importSource.properties ?? {}) as object).length ? { source: importSource } : {}),
    destination, title: { ...string, maxLength: 255, description: 'Optional display title for imported media; applies to each file lacking its own title. Not supported for cloud sources.' }, ...(oauth ? {} : { webhook }), idempotency_key: key,
  };
  const all: Tool[] = [
    {
      name: TOOL_NAMES.ANALYZE, title: 'Analyze media',
      description: 'Analyze media using exactly one of instruction or prompt_id and exactly one of files or source. Root files are native chat attachments: use the host-provided descriptors unchanged, including temporary authorized HTTPS URLs; do not ask users to publish videos. source selects existing media, a direct import, or local stdio file_paths within configured upload roots. Hosted tools cannot read local or sandbox paths. If the host has not supplied attachment descriptors, ask the user to attach files through a host that supports forwarding, or select existing VideoVector media. destination is only for new media. Returns analysis_id, progress, incremental accepted-part JSON and direct segment downloads. Retain the ID and follow next_action until terminal within host/user controls; after_seconds is a polling interval, not an ETA. Local transfers use the configured request timeout; observation is bounded to 30 seconds after upload. Download JSON/clips without OAuth headers; claim a file was saved only after saving succeeds.',
      inputSchema: { ...object({ instruction: string, prompt_id: string, files: ATTACHMENT_FILES_SCHEMA, source, destination, execution: object(EXECUTION_CONFIGURATION_PROPERTIES), ...(oauth ? {} : { webhook }), wait_seconds: wait, idempotency_key: key, detail }),
        ...oneSelector(['instruction', 'prompt_id']), allOf: [
          { not: { required: ['files', 'source'] } },
          { if: { required: ['destination', 'source'] }, then: oauth ? { not: {} } : { properties: { source: { anyOf: [...(options.includeLocalUpload === false ? [] : ['file_paths']), 'connector_id', 'connector'].map(name => ({ required: [name] })) } } } },
        ], examples: [ { instruction: 'Find product demonstrations', files: [{ file_id: 'file_123', download_url: 'https://files.example/clip.mp4' }] }, { prompt_id: 'prompt_123', source: { index_name: 'Interviews' } } ],
      } as Tool['inputSchema'], outputSchema: ANALYSIS_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.GET_ANALYSIS, title: 'Get analysis',
      description: 'Read progress or results without rerunning analysis. Use analysis_id, or video_id for its latest complete analysis. Wait at most 30 seconds for progress; no revision argument is needed. Follow next_action using the same ID. Accepted parts are available while other parts continue; media and image indexing may finish after extraction. Refresh expired JSON/clip grants here, or use full detail with page_size/cursor when files are unavailable.',
      inputSchema: { ...object({ analysis_id: string, video_id: string, wait_seconds: wait, detail, page_size: { type: 'integer', minimum: 1, maximum: 20, default: 1 }, cursor: string }), anyOf: [{ required: ['analysis_id'] }, { required: ['video_id'] }],
        allOf: [{ if: { anyOf: [{ required: ['cursor'] }, { required: ['page_size'] }] }, then: { required: ['detail'], properties: { detail: { const: 'full' } } } }],
        examples: [{ analysis_id: 'analysis_123' }, { video_id: 'video_123', detail: 'full', page_size: 1, wait_seconds: 0 }],
      } as Tool['inputSchema'], outputSchema: ANALYSIS_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.SEARCH, title: 'Search media',
      description: 'Search extracted results with text, an image, metadata filters, or a combination. Filters apply before ranking. A new search requires scope selecting one library, videos, Playground, or historical analyses. Library/video scopes use latest complete results per video. max_results bounds the saved match set; page_size bounds this response. Resume with search_id and an optional cursor without rerunning. Prefer the included JSON download over large inline results.',
      inputSchema: { ...object({ query: string, image_data: string, filters: searchFilters,
        scope: { ...object({ analysis_ids: ids, video_ids: ids, index_id: string, index_name: string, playground: { type: 'boolean', const: true } }), ...oneSelector(['analysis_ids', 'video_ids', 'index_id', 'index_name', 'playground']) },
        text_weight: { type: 'number', minimum: 0, maximum: 1 }, image_weight: { type: 'number', minimum: 0, maximum: 1 }, result_level: { type: 'string', enum: ['segment', 'video'], default: 'segment' },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, page_size: pageSize, search_id: string, cursor: string, idempotency_key: key, detail,
      }), oneOf: [
        { required: ['scope'], anyOf: [{ required: ['query'] }, { required: ['image_data'] }, { required: ['filters'] }], ...excludes('search_id', 'cursor') },
        { required: ['search_id'], ...excludes('query', 'image_data', 'filters', 'scope', 'text_weight', 'image_weight', 'result_level', 'max_results', 'idempotency_key') },
      ], examples: [{ query: 'presenter on stage', scope: { index_name: 'Interviews' }, max_results: 25, page_size: 10 }, { search_id: 'search_123' }],
      } as Tool['inputSchema'], outputSchema: WORKFLOW_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.IMPORT_MEDIA, title: 'Import media',
      description: 'Import media without analysis, inspect an existing import, or retry failed files. New imports require exactly one of root files or source. files are native host-provided attachment descriptors with temporary authorized HTTPS URLs, not publicly published videos. Local stdio can use source.file_paths within configured upload roots; hosted tools cannot read local or sandbox paths. If no attachment descriptors are available, ask the user to attach files through a supporting host. destination selects the library. Use import_id alone to inspect progress, outputs_cursor/failures_cursor for pages. Retry with retry=true and an idempotency_key; optional files renew expired attachment descriptors using the original file_ids. For failed analysis intake, use its analysis_id as import_id and follow the returned get_analysis action. Source, destination, prompt and title remain unchanged. Keep the returned import_id; analysis can later use source.import_id.',
      inputSchema: { ...object({ ...intakeProperties, import_id: string, retry: { type: 'boolean', const: true }, outputs_cursor: string, failures_cursor: string, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, wait_seconds: wait, detail }), allOf: [
        { not: { required: ['files', 'source'] } },
        { if: { required: ['title'] }, then: options.includeLocalUpload === false ? excludes('source') : { properties: { source: { required: ['file_paths'] } } } },
        { if: { required: ['import_id'] }, then: { allOf: [
          excludes('source', 'destination', 'title', ...(oauth ? [] : ['webhook'])),
          { if: { required: ['files'] }, then: { required: ['retry'] } },
        ] }, else: excludes('retry', 'outputs_cursor', 'failures_cursor', 'page_size') },
        { if: { required: ['retry'] }, then: { required: ['import_id', 'idempotency_key'], ...excludes('outputs_cursor', 'failures_cursor') } },
      ], examples: [{ files: [{ file_id: 'file_123', download_url: 'https://files.example/clip.mp4' }], destination: { index_name: 'Research' } }, { import_id: 'import_123' }],
      } as Tool['inputSchema'], outputSchema: importResultSchema,
    },
    {
      name: TOOL_NAMES.SAVE_PROMPT, title: 'Save prompt',
      description: 'Generate a reusable prompt from instruction or save an explicit definition. Supply prompt_id to update an owned prompt. save defaults to true; save=false returns a draft without persistence. Definitions contain extraction schemas and optional saved execution/selection settings. Reuse the same idempotency_key when retrying a save.',
      inputSchema: { ...object({ instruction: string, definition: promptDefinition, prompt_id: string, save: { type: 'boolean', default: true }, idempotency_key: key, detail }), ...oneSelector(['instruction', 'definition']), examples: [{ instruction: 'Extract visible brands and confidence', save: true }, { prompt_id: 'prompt_123', instruction: 'Also identify the product category', save: false }] } as Tool['inputSchema'], outputSchema: promptResultSchema,
    },
    {
      name: TOOL_NAMES.BROWSE, title: 'Browse media resources',
      description: 'Read indexes, videos, analyses, imports, or prompts. Choose resource first; optional ids select exact records and page_size/cursor paginate. name filters indexes/videos/prompts. index_id or index_name scopes videos/analyses/imports. video_ids filters analyses; status filters analyses/imports; include_defaults and active_only apply only to prompts. No creation, retries, exports, or webhook administration.',
      inputSchema: { ...object({ resource: { type: 'string', enum: Object.keys(browseFields) }, ids, name: string, index_id: string, index_name: string, video_ids: ids, status: string, include_defaults: { type: 'boolean', default: true }, active_only: { type: 'boolean', default: true }, page_size: pageSize, cursor: string, detail }, ['resource']),
        oneOf: Object.entries(browseFields).map(([resource, allowed]) => ({ properties: { resource: { const: resource } }, ...excludes(...browseSelectors.filter(name => !allowed.includes(name))) })),
        allOf: [{ not: { required: ['index_id', 'index_name'] } }, { not: { required: ['ids', 'name'] } }],
        examples: [{ resource: 'indexes', page_size: 20 }, { resource: 'analyses', index_name: 'Interviews', status: 'completed' }],
      } as Tool['inputSchema'], outputSchema: browseResultSchema,
    },
  ];
  return all.map(tool => ({ ...tool,
    annotations: getToolAnnotations(tool.name, options),
    ...(['analyze', 'import_media'].includes(tool.name) ? { _meta: { 'openai/fileParams': ['files'] } } : {}),
  }));
}
export function getToolCategory(name: string): string { return name === 'search' ? 'Search' : name === 'save_prompt' ? 'Prompts' : name === 'browse' ? 'Discovery' : 'Media'; }
export function getToolAvailability(_name: string): ToolAvailability { return { transports: ['stdio', 'streamable-http'] }; }
export function getToolRequiredScope(name: string, args?: Record<string, unknown>): ToolRequiredScope {
  if (name === 'search') return 'search';
  if (name === 'browse' || name === 'get_analysis' || (name === 'import_media' && args?.import_id !== undefined && args.retry !== true)) return 'read';
  return 'write';
}
export function getToolAnnotations(name: string, options: ToolDefinitionOptions = {}): NonNullable<Tool['annotations']> {
  const read = ['browse', 'get_analysis'].includes(name);
  const callbacks = !options.advertiseOAuth && ['analyze', 'import_media'].includes(name);
  return { readOnlyHint: read, destructiveHint: callbacks || name === 'save_prompt', idempotentHint: read, openWorldHint: callbacks };
}
export function getValidationToolDefinitions(options: ToolDefinitionOptions = {}): Tool[] {
  const selected = definitions(options);
  if (!options.advertiseOAuth) return selected;
  return selected.map(tool => ({ ...tool, securitySchemes: [{ type: 'oauth2' as const, scopes: [] }], _meta: { ...tool._meta, securitySchemes: [{ type: 'oauth2', scopes: [] }] } }));
}

function hasTypedShape(schema: Schema): boolean {
  return schema.type !== undefined
    || Object.values((schema.properties ?? {}) as Record<string, Schema>).some(hasTypedShape)
    || ['oneOf', 'anyOf'].some(keyword => Array.isArray(schema[keyword])
      && (schema[keyword] as Schema[]).some(hasTypedShape));
}

function modelInputSchema(schema: Schema): Schema {
  // Hosts may render required-only combinator branches as generic records and
  // hide sibling typed fields, including native file parameters. Keep one
  // property tree for discovery; the unprojected schema validates every call.
  const result: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'oneOf' || key === 'anyOf') {
      // Preserve alternatives that declare actual input shapes (cloud provider
      // configuration and filter values), rather than required-only selectors.
      if ((value as Schema[]).some(hasTypedShape)) result[key] = (value as Schema[]).map(modelInputSchema);
      continue;
    }
    if (['allOf', 'not', 'if', 'then', 'else'].includes(key)) continue;
    if (key === 'properties') {
      result[key] = Object.fromEntries(Object.entries(value as Record<string, Schema>)
        .map(([name, child]) => [name, modelInputSchema(child)]));
    } else if (['items', 'additionalProperties'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = modelInputSchema(value as Schema);
    } else result[key] = value;
  }
  return result;
}

export function getToolDefinitions(options: ToolDefinitionOptions = {}): Tool[] {
  return getValidationToolDefinitions(options).map(tool => ({ ...tool,
    inputSchema: modelInputSchema(tool.inputSchema) as Tool['inputSchema'],
  }));
}
export const TOOL_DEFINITIONS = getToolDefinitions();
export function getToolDefinition(name: string): Tool | undefined { return TOOL_DEFINITIONS.find(tool => tool.name === name); }
