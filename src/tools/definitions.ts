/** The single model-facing catalog. Native REST client methods are independent. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MAX_ATTACHMENT_FILES } from '../attachments/limits.js';
import { ANALYSIS_RESULT_SCHEMA, SEARCH_RESULT_SCHEMA } from './workflow-result-contract.js';

export const ATTACHMENT_FILES_SCHEMA = {
  type: 'array', minItems: 1, maxItems: MAX_ATTACHMENT_FILES,
  description: 'Native chat attachments supplied by the host; pass descriptors unchanged. Their temporary authorized HTTPS URLs do not require public publishing. At most eight files, each at most 2 GiB.',
  items: { type: 'object', properties: {
    download_url: { type: 'string', minLength: 1, format: 'uri', pattern: '^https://', description: 'Host-provided temporary authorized download URL, not a local or sandbox path. Do not invent or publicly publish a URL.' }, file_id: { type: 'string', minLength: 1 },
    mime_type: { type: 'string' }, file_name: { type: 'string' },
  }, required: ['download_url', 'file_id'], additionalProperties: false },
};
export const TOOL_NAMES = { ANALYZE: 'analyze', GET_ANALYSIS: 'get_analysis', SEARCH: 'search', IMPORT_MEDIA: 'import_media', BROWSE: 'browse' } as const;
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
  const url = { type: 'string', minLength: 1, maxLength: 16384, format: 'uri', pattern: '^https://' };
  const selectors: Record<string, unknown> = {
    urls: { oneOf: [url, { type: 'array', minItems: 1, maxItems: MAX_ATTACHMENT_FILES, items: url }], description: 'One public HTTPS media or individual YouTube URL, or up to eight URLs. The backend imports them directly; do not download them first.' },
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
const EXECUTION_CONFIGURATION_SCHEMA = object({
  processing_model: { type: ['string', 'null'], minLength: 1, description: 'Model ID published by the billing pricing API.' },
  enable_image_embedding: { type: 'boolean' },
});

const searchFilters = { type: 'array', minItems: 1, maxItems: 4, items: {
  ...object({ field: string, operator: { type: 'string', enum: ['equals', 'greater_than', 'greater_equal', 'less_than', 'less_equal', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty', 'item_equals', 'item_contains', 'length_equals', 'length_greater', 'length_less'], default: 'equals' }, value: {} }, ['field']),
  if: { required: ['operator'], properties: { operator: { enum: ['is_empty', 'is_not_empty'] } } }, then: excludes('value'), else: { required: ['value'] },
} };
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
      description: 'Extract segment and whole-media information together from attached files, media links, or saved media. Start here when the user asks to summarize, understand, classify, find moments, or answer a question requiring new extraction. Describe the desired fields and evidence clearly. Every extraction includes both scopes; use results or search for downstream filtering. Returns processing progress and available results or clip downloads. New processing uses credits.',
      inputSchema: { ...object({ instruction: string, prompt_id: string, files: ATTACHMENT_FILES_SCHEMA, source, destination, execution: EXECUTION_CONFIGURATION_SCHEMA, ...(oauth ? {} : { webhook }), wait_seconds: wait, idempotency_key: key, detail }),
        ...oneSelector(['instruction', 'prompt_id']), allOf: [
          { not: { required: ['files', 'source'] } },
          { if: { required: ['destination', 'source'] }, then: { properties: { source: { anyOf: ['urls', ...(options.includeLocalUpload === false ? [] : ['file_paths']), ...(oauth ? [] : ['connector_id', 'connector'])].map(name => ({ required: [name] })) } } } },
        ], examples: [ { instruction: 'Find product demonstrations', files: [{ file_id: 'file_123', download_url: 'https://files.example/clip.mp4' }] }, { prompt_id: 'prompt_123', source: { index_name: 'Interviews' } } ],
      } as Tool['inputSchema'], outputSchema: ANALYSIS_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.GET_ANALYSIS, title: 'Get analysis',
      description: 'Read the extracted content and progress of an existing analysis. Load these results into context for general questions about a video, unless the needed content is already available. Also retrieves partial or final output and refreshes download links. Reading results does not start another analysis; continue observing an unfinished task until it reaches a terminal state.',
      inputSchema: { ...object({ analysis_id: string, video_id: string, wait_seconds: wait, detail, page_size: { type: 'integer', minimum: 1, maximum: 20, default: 1 }, cursor: string }), anyOf: [{ required: ['analysis_id'] }, { required: ['video_id'] }],
        allOf: [{ if: { anyOf: [{ required: ['cursor'] }, { required: ['page_size'] }] }, then: { required: ['detail'], properties: { detail: { const: 'full' } } } }],
        examples: [{ analysis_id: 'analysis_123' }, { video_id: 'video_123', detail: 'full', page_size: 1, wait_seconds: 0 }],
      } as Tool['inputSchema'], outputSchema: ANALYSIS_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.SEARCH, title: 'Search media',
      description: 'Find relevant videos or scenes in a large, already-processed index or collection whose extracted content cannot fit in chat context. Query by meaning, reference image, or metadata filters within an explicit scope. Returns a limited set of matching results and continuation pages. It retrieves existing information rather than extracting new details.',
      inputSchema: { ...object({ query: string, image_data: string, filters: searchFilters,
        scope: { ...object({ analysis_ids: ids, video_ids: ids, index_id: string, index_name: string, playground: { type: 'boolean', const: true } }), ...oneSelector(['analysis_ids', 'video_ids', 'index_id', 'index_name', 'playground']) },
        text_weight: { type: 'number', minimum: 0, maximum: 1 }, image_weight: { type: 'number', minimum: 0, maximum: 1 }, result_level: { type: 'string', enum: ['segment', 'video'], default: 'segment' },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, page_size: pageSize, search_id: string, cursor: string, idempotency_key: key, detail,
      }), oneOf: [
        { required: ['scope'], anyOf: [{ required: ['query'] }, { required: ['image_data'] }, { required: ['filters'] }], ...excludes('search_id', 'cursor') },
        { required: ['search_id'], ...excludes('query', 'image_data', 'filters', 'scope', 'text_weight', 'image_weight', 'result_level', 'max_results', 'idempotency_key') },
      ], examples: [{ query: 'presenter on stage', scope: { index_name: 'Interviews' }, max_results: 25, page_size: 10 }, { search_id: 'search_123' }],
      } as Tool['inputSchema'], outputSchema: SEARCH_RESULT_SCHEMA,
    },
    {
      name: TOOL_NAMES.IMPORT_MEDIA, title: 'Import media',
      description: 'Transfer attached files or linked media into VideoVector for later use, without requesting extraction. Use for upload, copy, or import jobs when the user has no question about the content or explicitly wants transfer only. Can import into Playground or an index, report progress, and resume a failed transfer when the user requests recovery.',
      inputSchema: { ...object({ ...intakeProperties, import_id: string, retry: { type: 'boolean', const: true }, outputs_cursor: string, failures_cursor: string, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, wait_seconds: wait, detail }), allOf: [
        { not: { required: ['files', 'source'] } },
        { if: { required: ['title'] }, then: { properties: { source: { anyOf: ['urls', ...(options.includeLocalUpload === false ? [] : ['file_paths'])].map(name => ({ required: [name] })) } } } },
        { if: { required: ['import_id'] }, then: { allOf: [
          excludes('source', 'destination', 'title', ...(oauth ? [] : ['webhook'])),
          { if: { required: ['files'] }, then: { required: ['retry'] } },
        ] }, else: excludes('retry', 'outputs_cursor', 'failures_cursor', 'page_size') },
        { if: { required: ['retry'] }, then: { required: ['import_id', 'idempotency_key'], ...excludes('outputs_cursor', 'failures_cursor') } },
      ], examples: [{ files: [{ file_id: 'file_123', download_url: 'https://files.example/clip.mp4' }], destination: { index_name: 'Research' } }, { import_id: 'import_123' }],
      } as Tool['inputSchema'], outputSchema: importResultSchema,
    },
    {
      name: TOOL_NAMES.BROWSE, title: 'Browse media resources',
      description: 'Find saved indexes, videos, analyses, imports, or prompts in the account. Use names, identifiers, or resource-specific filters to locate an item, inspect its basic information, or choose an existing processing result. Returns resource records and paginated lists; it does not search inside extracted video content or start processing.',
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
export function getToolCategory(name: string): string { return name === 'search' ? 'Search' : name === 'browse' ? 'Discovery' : 'Media'; }
export function getToolAvailability(_name: string): ToolAvailability { return { transports: ['stdio', 'streamable-http'] }; }
export function getToolRequiredScope(name: string, args?: Record<string, unknown>): ToolRequiredScope {
  if (name === 'search') return 'search';
  if (name === 'browse' || name === 'get_analysis' || (name === 'import_media' && args?.import_id !== undefined && args.retry !== true)) return 'read';
  return 'write';
}
export function getToolAnnotations(name: string, options: ToolDefinitionOptions = {}): NonNullable<Tool['annotations']> {
  const read = ['browse', 'get_analysis'].includes(name);
  const importsMedia = ['analyze', 'import_media'].includes(name);
  const callbacks = !options.advertiseOAuth && importsMedia;
  // Both OAuth and direct clients can import user-supplied public media URLs.
  // Disabling callbacks does not restrict those tools to a private workspace.
  return { readOnlyHint: read, destructiveHint: callbacks, idempotentHint: read, openWorldHint: importsMedia };
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
