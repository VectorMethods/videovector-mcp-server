/**
 * Thin MCP handlers for the simplified VideoVector workflow facade.
 *
 * Scope resolution, tenancy, billing, idempotency, and search pagination are
 * authoritative in the backend. These handlers only validate agent inputs,
 * protect local file access, and forward the canonical workflow contract.
 */

import { promises as fs } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { TextContent } from '@modelcontextprotocol/sdk/types.js';

import type { VideoVectorClient } from '../client/index.js';
import type {
  FilterOperator,
  WorkflowFilterCondition,
  WorkflowProcessRequest,
  WorkflowResultLevel,
  WorkflowSearchRequest,
  WorkflowSegmentationMode,
} from '../types/index.js';
import { formatError } from '../utils/helpers.js';
import { TOOL_NAMES } from './definitions.js';

export interface WorkflowToolContext {
  transportMode?: 'stdio' | 'http';
  uploadRoots?: string[];
}

interface ToolHandlerResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface AuthorizedUploadFile {
  filePath: string;
  identity: {
    device: number;
    inode: number;
    size: number;
    modifiedMs: number;
  };
}

type WorkflowHandler = (
  args: Record<string, unknown>,
  client: VideoVectorClient,
  context: WorkflowToolContext
) => Promise<ToolHandlerResult>;

const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  '.avi',
  '.aac',
  '.bmp',
  '.flac',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.png',
  '.tiff',
  '.wav',
  '.webm',
  '.webp',
]);

const FILTER_OPERATORS = new Set<FilterOperator>([
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
]);

const VALUELESS_FILTER_OPERATORS = new Set<FilterOperator>([
  'is_empty',
  'is_not_empty',
]);

const UPLOAD_MEDIA_ARGUMENTS = new Set([
  'file_path',
  'title',
  'index_id',
  'index_name',
  'idempotency_key',
]);
const DEFINE_PROMPT_ARGUMENTS = new Set([
  'instruction',
  'save',
  'idempotency_key',
]);
const PROCESS_MEDIA_ARGUMENTS = new Set([
  'prompt_id',
  'prompt_instruction',
  'video_ids',
  'index_id',
  'index_name',
  'segmentation_mode',
  'fixed_segment_duration_seconds',
  'advanced_transcription',
  'create_image_embeddings',
  'idempotency_key',
]);
const SEARCH_MEDIA_ARGUMENTS = new Set([
  'query',
  'filters',
  'result_level',
  'video_ids',
  'prompt_run_ids',
  'index_id',
  'index_name',
  'limit',
  'cursor',
  'idempotency_key',
]);
const FILTER_CONDITION_ARGUMENTS = new Set([
  'field',
  'operator',
  'value',
]);

function result(data: Record<string, unknown>): ToolHandlerResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function validateExactKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string
): void {
  const unknownKeys = Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} contains unknown argument${unknownKeys.length === 1 ? '' : 's'}: `
      + unknownKeys.join(', ')
    );
  }
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredFilePath(args: Record<string, unknown>): string {
  const value = args.file_path;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('file_path must be a non-empty string');
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(
  args: Record<string, unknown>,
  field: string,
  defaultValue: boolean
): boolean {
  const value = args[field];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalStringList(
  args: Record<string, unknown>,
  field: string,
  maxItems: number = 100
): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of strings`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${field} must contain only non-empty strings`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  if (normalized.length > maxItems) {
    throw new Error(`${field} cannot contain more than ${maxItems} unique values`);
  }
  return normalized;
}

function validateIndexSelector(indexId?: string, indexName?: string): void {
  if (indexId !== undefined && indexName !== undefined) {
    throw new Error('Provide either index_id or index_name, not both');
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  );
}

export async function authorizeUploadFile(
  filePath: string,
  uploadRoots: string[]
): Promise<AuthorizedUploadFile> {
  const configuredRoots = uploadRoots.length > 0 ? uploadRoots : [process.cwd()];
  const roots = await Promise.all(
    configuredRoots.map(async (root) => {
      const canonicalRoot = await fs.realpath(resolve(root));
      const rootStat = await fs.stat(canonicalRoot);
      if (!rootStat.isDirectory()) {
        throw new Error(`Configured upload root is not a directory: ${root}`);
      }
      return canonicalRoot;
    })
  );

  const canonicalFile = await fs.realpath(resolve(filePath));
  if (!roots.some((root) => isWithinRoot(canonicalFile, root))) {
    throw new Error('file_path is outside the configured upload roots');
  }

  const extension = extname(canonicalFile).toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported media extension '${extension || '(none)'}'. `
      + `Supported extensions: ${Array.from(SUPPORTED_MEDIA_EXTENSIONS).sort().join(', ')}`
    );
  }

  const fileStat = await fs.stat(canonicalFile);
  if (!fileStat.isFile()) {
    throw new Error('file_path must resolve to a regular file');
  }

  return {
    filePath: canonicalFile,
    identity: {
      device: fileStat.dev,
      inode: fileStat.ino,
      size: fileStat.size,
      modifiedMs: fileStat.mtimeMs,
    },
  };
}

async function handleUploadMedia(
  args: Record<string, unknown>,
  client: VideoVectorClient,
  context: WorkflowToolContext
): Promise<ToolHandlerResult> {
  validateExactKeys(args, UPLOAD_MEDIA_ARGUMENTS, 'upload_media');
  if (context.transportMode !== 'stdio') {
    throw new Error('upload_media is available only through the local stdio transport');
  }

  const filePath = requiredFilePath(args);
  const title = optionalString(args, 'title');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  const idempotencyKey = optionalString(args, 'idempotency_key');
  validateIndexSelector(indexId, indexName);

  const authorized = await authorizeUploadFile(filePath, context.uploadRoots ?? []);
  const response = await client.workflowUploadMedia(
    {
      file_path: authorized.filePath,
      ...(title === undefined ? {} : { title }),
      ...(indexId === undefined ? {} : { index_id: indexId }),
      ...(indexName === undefined ? {} : { index_name: indexName }),
    },
    idempotencyKey,
    authorized.identity
  );
  return result(response);
}

async function handleDefinePrompt(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  validateExactKeys(args, DEFINE_PROMPT_ARGUMENTS, 'define_prompt');
  const instruction = requiredString(args, 'instruction');
  const save = optionalBoolean(args, 'save', true);
  const idempotencyKey = optionalString(args, 'idempotency_key');
  const response = await client.workflowDefinePrompt({ instruction, save }, idempotencyKey);
  return result(response);
}

function readSegmentationMode(
  args: Record<string, unknown>
): WorkflowSegmentationMode | undefined {
  const mode = optionalString(args, 'segmentation_mode');
  if (mode !== undefined && mode !== 'content_aware' && mode !== 'fixed') {
    throw new Error('segmentation_mode must be one of: content_aware, fixed');
  }
  return mode;
}

function readFixedDuration(
  args: Record<string, unknown>,
  mode: WorkflowSegmentationMode | undefined
): number | undefined {
  const value = args.fixed_segment_duration_seconds;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (mode !== 'fixed') {
    throw new Error('fixed_segment_duration_seconds is only valid when segmentation_mode is fixed');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 300) {
    throw new Error('fixed_segment_duration_seconds must be an integer between 1 and 300');
  }
  return value;
}

async function handleProcessMedia(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  validateExactKeys(args, PROCESS_MEDIA_ARGUMENTS, 'process_media');
  const promptId = optionalString(args, 'prompt_id');
  const promptInstruction = optionalString(args, 'prompt_instruction');
  if ((promptId === undefined) === (promptInstruction === undefined)) {
    throw new Error('Provide exactly one of prompt_id or prompt_instruction');
  }

  const videoIds = optionalStringList(args, 'video_ids');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  validateIndexSelector(indexId, indexName);

  const segmentationMode = readSegmentationMode(args);
  const fixedDuration = readFixedDuration(args, segmentationMode);
  const request: WorkflowProcessRequest = {
    ...(promptId === undefined ? {} : { prompt_id: promptId }),
    ...(promptInstruction === undefined ? {} : { prompt_instruction: promptInstruction }),
    ...(videoIds === undefined ? {} : { video_ids: videoIds }),
    ...(indexId === undefined ? {} : { index_id: indexId }),
    ...(indexName === undefined ? {} : { index_name: indexName }),
    ...(segmentationMode === undefined ? {} : { segmentation_mode: segmentationMode }),
    ...(fixedDuration === undefined
      ? {}
      : { fixed_segment_duration_seconds: fixedDuration }),
    ...(args.advanced_transcription === undefined || args.advanced_transcription === null
      ? {}
      : { advanced_transcription: optionalBoolean(args, 'advanced_transcription', false) }),
    ...(args.create_image_embeddings === undefined || args.create_image_embeddings === null
      ? {}
      : { create_image_embeddings: optionalBoolean(args, 'create_image_embeddings', false) }),
  };

  const response = await client.workflowProcessMedia(
    request,
    optionalString(args, 'idempotency_key')
  );
  return result(response);
}

function readResultLevel(args: Record<string, unknown>): WorkflowResultLevel {
  const level = optionalString(args, 'result_level') ?? 'segment';
  if (level !== 'segment' && level !== 'video') {
    throw new Error('result_level must be one of: segment, video');
  }
  return level;
}

function readFilters(args: Record<string, unknown>): WorkflowFilterCondition[] | undefined {
  const value = args.filters;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('filters must contain between 1 and 4 conditions');
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`filters[${index}] must be an object`);
    }
    const condition = item as Record<string, unknown>;
    validateExactKeys(condition, FILTER_CONDITION_ARGUMENTS, `filters[${index}]`);
    const field = requiredString(condition, 'field');
    const rawOperator = optionalString(condition, 'operator') ?? 'equals';
    if (!FILTER_OPERATORS.has(rawOperator as FilterOperator)) {
      throw new Error(`filters[${index}].operator is not supported`);
    }
    const operator = rawOperator as FilterOperator;
    const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value')
      && condition.value !== undefined;
    if (VALUELESS_FILTER_OPERATORS.has(operator) && hasValue) {
      throw new Error(`filters[${index}].value must be omitted for ${operator}`);
    }
    if (!VALUELESS_FILTER_OPERATORS.has(operator) && !hasValue) {
      throw new Error(`filters[${index}].value is required for ${operator}`);
    }
    return {
      field,
      operator,
      ...(hasValue ? { value: condition.value } : {}),
    };
  });
}

function readLimit(args: Record<string, unknown>): number {
  const value = args.limit ?? 10;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('limit must be an integer between 1 and 50');
  }
  return value;
}

async function handleSearchMedia(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  validateExactKeys(args, SEARCH_MEDIA_ARGUMENTS, 'search_media');
  const cursor = optionalString(args, 'cursor');
  if (cursor !== undefined) {
    const supplied = Object.entries(args)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key]) => key);
    if (supplied.length !== 1 || supplied[0] !== 'cursor') {
      throw new Error('When cursor is provided, omit every other search_media argument');
    }
    return result(await client.workflowSearchPage(cursor));
  }

  const query = optionalString(args, 'query');
  const filters = readFilters(args);
  if ((query === undefined) === (filters === undefined)) {
    throw new Error('Provide exactly one of query or filters');
  }

  const videoIds = optionalStringList(args, 'video_ids');
  const promptRunIds = optionalStringList(args, 'prompt_run_ids');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  validateIndexSelector(indexId, indexName);
  if (promptRunIds !== undefined && videoIds !== undefined) {
    throw new Error('Provide either video_ids or prompt_run_ids, not both');
  }
  if (
    (videoIds !== undefined || promptRunIds !== undefined)
    && (indexId !== undefined || indexName !== undefined)
  ) {
    throw new Error(
      'video_ids and prompt_run_ids cannot be combined with index_id or index_name'
    );
  }

  const request: WorkflowSearchRequest = {
    ...(query === undefined ? {} : { query }),
    ...(filters === undefined ? {} : { filters }),
    result_level: readResultLevel(args),
    ...(videoIds === undefined ? {} : { video_ids: videoIds }),
    ...(promptRunIds === undefined ? {} : { prompt_run_ids: promptRunIds }),
    ...(indexId === undefined ? {} : { index_id: indexId }),
    ...(indexName === undefined ? {} : { index_name: indexName }),
    limit: readLimit(args),
  };
  const response = await client.workflowSearchMedia(
    request,
    optionalString(args, 'idempotency_key')
  );
  return result(response);
}

export const WORKFLOW_HANDLERS: Record<string, WorkflowHandler> = {
  [TOOL_NAMES.UPLOAD_MEDIA]: handleUploadMedia,
  [TOOL_NAMES.DEFINE_PROMPT]: handleDefinePrompt,
  [TOOL_NAMES.PROCESS_MEDIA]: handleProcessMedia,
  [TOOL_NAMES.SEARCH_MEDIA]: handleSearchMedia,
};

export function isWorkflowTool(toolName: string): boolean {
  return toolName in WORKFLOW_HANDLERS;
}

export async function executeWorkflowTool(
  toolName: string,
  args: Record<string, unknown>,
  client: VideoVectorClient,
  context: WorkflowToolContext = {}
): Promise<ToolHandlerResult> {
  const handler = WORKFLOW_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown workflow tool: ${toolName}`);
  }
  try {
    return await handler(args, client, context);
  } catch (error) {
    return formatError(error);
  }
}
