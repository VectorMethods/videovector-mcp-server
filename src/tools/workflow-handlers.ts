/**
 * Thin MCP handlers for the simplified VideoVector workflow facade.
 *
 * Scope resolution, tenancy, billing, idempotency, and search pagination are
 * authoritative in the backend. These handlers only validate agent inputs,
 * protect local file access, and forward the canonical workflow contract.
 */

import { createHash, randomUUID } from 'node:crypto';
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
  WorkflowAttachment,
  WorkflowIntakeResponse,
} from '../types/index.js';
import { formatError, ToolInputError } from '../utils/helpers.js';
import { TOOL_NAMES } from './definitions.js';

export interface WorkflowToolContext {
  transportMode?: 'stdio' | 'http';
  uploadRoots?: string[];
  authenticationKind?: 'api-key' | 'oauth';
}

interface ToolHandlerResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
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
  'files',
  'file_path',
  'title',
  'index_id',
  'index_name',
  'idempotency_key',
]);
const FIND_ARGUMENTS = new Set(['instruction', 'files', 'file_paths', 'idempotency_key']);
const DEFINE_PROMPT_ARGUMENTS = new Set([
  'instruction',
  'save',
  'idempotency_key',
]);
const PROCESS_MEDIA_ARGUMENTS = new Set([
  'import_job_id',
  'prompt_id',
  'prompt_instruction',
  'video_ids',
  'index_id',
  'index_name',
  'video_segmentation_type',
  'audio_segmentation_type',
  'video_segment_duration',
  'audio_segment_duration',
  'processing_model',
  'enable_transcription',
  'enable_image_embedding',
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
    throw new ToolInputError(
      `${label} contains unknown argument${unknownKeys.length === 1 ? '' : 's'}: `
      + unknownKeys.join(', ')
    );
  }
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredFilePath(args: Record<string, unknown>): string {
  const value = args.file_path;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError('file_path must be a non-empty string');
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`${field} must be a non-empty string`);
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
    throw new ToolInputError(`${field} must be a boolean`);
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
    throw new ToolInputError(`${field} must be a non-empty array of strings`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ToolInputError(`${field} must contain only non-empty strings`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  if (normalized.length > maxItems) {
    throw new ToolInputError(`${field} cannot contain more than ${maxItems} unique values`);
  }
  return normalized;
}

function validateIndexSelector(indexId?: string, indexName?: string): void {
  if (indexId !== undefined && indexName !== undefined) {
    throw new ToolInputError('Provide either index_id or index_name, not both');
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
    throw new ToolInputError('file_path is outside the configured upload roots');
  }

  const extension = extname(canonicalFile).toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension)) {
    throw new ToolInputError(
      `Unsupported media extension '${extension || '(none)'}'. `
      + `Supported extensions: ${Array.from(SUPPORTED_MEDIA_EXTENSIONS).sort().join(', ')}`
    );
  }

  const fileStat = await fs.stat(canonicalFile);
  if (!fileStat.isFile()) {
    throw new ToolInputError('file_path must resolve to a regular file');
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

export function attachmentFiles(args: Record<string, unknown>): WorkflowAttachment[] | undefined {
  if (args.files === undefined) return undefined;
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 100) {
    throw new ToolInputError('files must contain between 1 and 100 file descriptors');
  }
  return args.files.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ToolInputError('Each file must be a host-provided file descriptor');
    }
    const file = value as Record<string, unknown>;
    validateExactKeys(file, new Set(['download_url', 'file_id', 'mime_type', 'file_name']), 'file');
    requiredString(file, 'download_url');
    requiredString(file, 'file_id');
    for (const name of ['mime_type', 'file_name']) {
      if (file[name] !== undefined && typeof file[name] !== 'string') {
        throw new ToolInputError(`file.${name} must be a string`);
      }
    }
    return file as unknown as WorkflowAttachment;
  });
}

function intakeResult(response: WorkflowIntakeResponse, client: VideoVectorClient): ToolHandlerResult {
  const data: Record<string, unknown> = {
    job_id: response.job_id, status: response.status, video_ids: response.video_ids,
    phase: response.phase, outputs: response.outputs, execution: response.execution,
    ...(response.run_id === undefined ? {} : { run_id: response.run_id }),
    ...(response.source_kind === undefined ? {} : { source_kind: response.source_kind }),
    ...(response.target_index_id === undefined ? {} : { target_index_id: response.target_index_id }),
    ...(response.progress === undefined ? {} : { progress: response.progress }),
    ...(response.failed_files_next_cursor === undefined ? {} : { failed_files_next_cursor: response.failed_files_next_cursor }),
    ...(response.failed_files === undefined ? {} : { failed_files: response.failed_files }),
    ...(response.error_message === undefined ? {} : { error_message: response.error_message }),
  };
  if (!response.upload) return result(data);
  client.validateUploadGrant(response.job_id, response.upload);
  return { ...result(data), _meta: { upload: response.upload } };
}

async function handleAttachmentIntake(
  args: Record<string, unknown>,
  client: VideoVectorClient,
  context: WorkflowToolContext,
  find: boolean,
): Promise<ToolHandlerResult> {
  validateExactKeys(args, find ? FIND_ARGUMENTS : UPLOAD_MEDIA_ARGUMENTS, find ? 'find' : 'upload_media');
  const localField = find ? 'file_paths' : 'file_path';
  if (args[localField] !== undefined && context.transportMode !== 'stdio') {
    throw new ToolInputError(`${localField} is available only through the local stdio transport`);
  }
  const files = attachmentFiles(args);
  const paths = args[localField] === undefined ? []
    : find ? optionalStringList(args, 'file_paths')! : [requiredFilePath(args)];
  if (files && paths.length) throw new ToolInputError('files and local paths are mutually exclusive');
  const authorized = await Promise.all(paths.map((path) => authorizeUploadFile(path, context.uploadRoots ?? [])));
  const instruction = find ? requiredString(args, 'instruction') : undefined;
  const title = optionalString(args, 'title');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  const idempotencyKey = optionalString(args, 'idempotency_key') ?? `intake:${randomUUID()}`;
  validateIndexSelector(indexId, indexName);
  let response = find
    ? await client.workflowFind({ instruction: instruction!, artifact_delivery: 'automatic', ...(files ? { files } : {}) }, idempotencyKey)
    : await client.workflowAttachments({
      ...(files ? { files } : {}),
      ...(title === undefined ? {} : { title }),
      ...(indexId === undefined ? {} : { index_id: indexId }),
      ...(indexName === undefined ? {} : { index_name: indexName }),
    }, idempotencyKey);
  if (authorized.length && response.upload) {
    const grant = response.upload;
    const fileIds = authorized.map((_, index) => createHash('sha256').update(`${idempotencyKey}\0${index}`).digest('hex'));
    for (const [index, file] of authorized.entries()) {
      await client.workflowUploadAttachment(response.job_id, grant, file.filePath, fileIds[index]!, file.identity);
    }
    response = await client.workflowCompleteAttachments(response.job_id, grant, fileIds);
  }
  return intakeResult(response, client);
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

function readExecutionOverrides(args: Record<string, unknown>): Partial<WorkflowProcessRequest> {
  const overrides: Record<string, unknown> = {};
  for (const field of ['video_segmentation_type', 'audio_segmentation_type', 'processing_model']) {
    const value = optionalString(args, field);
    if (value !== undefined) {
      if (field !== 'processing_model' && !['fixed', 'content_aware'].includes(value)) {
        throw new ToolInputError(`${field} must be fixed or content_aware`);
      }
      overrides[field] = value;
    }
  }
  for (const field of ['video_segment_duration', 'audio_segment_duration']) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 300) {
      throw new ToolInputError(`${field} must be an integer between 1 and 300`);
    }
    overrides[field] = value;
  }
  for (const field of ['enable_transcription', 'enable_image_embedding']) {
    if (args[field] !== undefined && args[field] !== null) {
      overrides[field] = optionalBoolean(args, field, false);
    }
  }
  // The backend resolves omitted values from the saved execution configuration
  // and validates the complete merged configuration once.
  return overrides as Partial<WorkflowProcessRequest>;
}

async function handleProcessMedia(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  validateExactKeys(args, PROCESS_MEDIA_ARGUMENTS, 'process_media');
  const promptId = optionalString(args, 'prompt_id');
  const promptInstruction = optionalString(args, 'prompt_instruction');
  if ((promptId === undefined) === (promptInstruction === undefined)) {
    throw new ToolInputError('Provide exactly one of prompt_id or prompt_instruction');
  }

  const videoIds = optionalStringList(args, 'video_ids');
  const importJobId = optionalString(args, 'import_job_id');
  if (videoIds !== undefined && importJobId !== undefined) throw new ToolInputError('Provide either import_job_id or video_ids, not both');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  validateIndexSelector(indexId, indexName);

  const request: WorkflowProcessRequest = {
    artifact_delivery: 'automatic',
    ...(importJobId === undefined ? {} : { import_job_id: importJobId }),
    ...(promptId === undefined ? {} : { prompt_id: promptId }),
    ...(promptInstruction === undefined ? {} : { prompt_instruction: promptInstruction }),
    ...(videoIds === undefined ? {} : { video_ids: videoIds }),
    ...(indexId === undefined ? {} : { index_id: indexId }),
    ...(indexName === undefined ? {} : { index_name: indexName }),
    ...readExecutionOverrides(args),
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
    throw new ToolInputError('result_level must be one of: segment, video');
  }
  return level;
}

function readFilters(args: Record<string, unknown>): WorkflowFilterCondition[] | undefined {
  const value = args.filters;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new ToolInputError('filters must contain between 1 and 4 conditions');
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ToolInputError(`filters[${index}] must be an object`);
    }
    const condition = item as Record<string, unknown>;
    validateExactKeys(condition, FILTER_CONDITION_ARGUMENTS, `filters[${index}]`);
    const field = requiredString(condition, 'field');
    const rawOperator = optionalString(condition, 'operator') ?? 'equals';
    if (!FILTER_OPERATORS.has(rawOperator as FilterOperator)) {
      throw new ToolInputError(`filters[${index}].operator is not supported`);
    }
    const operator = rawOperator as FilterOperator;
    const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value')
      && condition.value !== undefined;
    if (VALUELESS_FILTER_OPERATORS.has(operator) && hasValue) {
      throw new ToolInputError(`filters[${index}].value must be omitted for ${operator}`);
    }
    if (!VALUELESS_FILTER_OPERATORS.has(operator) && !hasValue) {
      throw new ToolInputError(`filters[${index}].value is required for ${operator}`);
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
    throw new ToolInputError('limit must be an integer between 1 and 50');
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
      throw new ToolInputError(
        'When cursor is provided, omit every other search_media argument'
      );
    }
    return result(await client.workflowSearchPage(cursor));
  }

  const query = optionalString(args, 'query');
  const filters = readFilters(args);
  if (query === undefined && filters === undefined) {
    throw new ToolInputError('Provide query, filters, or both');
  }

  const videoIds = optionalStringList(args, 'video_ids');
  const promptRunIds = optionalStringList(args, 'prompt_run_ids');
  const indexId = optionalString(args, 'index_id');
  const indexName = optionalString(args, 'index_name');
  validateIndexSelector(indexId, indexName);
  if (promptRunIds !== undefined && videoIds !== undefined) {
    throw new ToolInputError('Provide either video_ids or prompt_run_ids, not both');
  }
  if (
    (videoIds !== undefined || promptRunIds !== undefined)
    && (indexId !== undefined || indexName !== undefined)
  ) {
    throw new ToolInputError(
      'video_ids and prompt_run_ids cannot be combined with index_id or index_name'
    );
  }

  const request: WorkflowSearchRequest = {
    artifact_delivery: 'automatic',
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
  [TOOL_NAMES.UPLOAD_MEDIA]: (args, client, context) => handleAttachmentIntake(args, client, context, false),
  [TOOL_NAMES.FIND]: (args, client, context) => handleAttachmentIntake(args, client, context, true),
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
    return formatError(error, {
      authenticationKind: context.authenticationKind,
    });
  }
}
