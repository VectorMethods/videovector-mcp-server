/** MCP validation and local uploads; backend facade owns workflow semantics. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { VideoVectorClient } from '../client/index.js';
import type { McpToolResponse, WorkflowUploadGrant } from '../types/index.js';
import { VideoVectorApiError } from '../types/index.js';
import { formatError, ToolInputError } from '../utils/helpers.js';
import { getValidationToolDefinitions, TOOL_NAMES, type ToolName } from './definitions.js';
import { uploadAttachmentBatch } from '../attachments/upload-batch.js';

export interface WorkflowToolContext {
  transportMode?: 'stdio' | 'http'; uploadRoots?: string[]; authenticationKind?: 'api-key' | 'oauth';
  signal?: AbortSignal; deadline?: number;
  onProgress?: (message: string, progress?: number, total?: number) => Promise<void>;
}
interface AuthorizedUploadFile { filePath: string; identity: { device: number; inode: number; size: number; modifiedMs: number }; }
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


const validator = new AjvJsonSchemaValidator();
const catalogs = new Map<string, ReturnType<typeof getValidationToolDefinitions>>();
function validateArguments(name: string, args: Record<string, unknown>, context: WorkflowToolContext): void {
  if ((name === 'analyze' || (name === 'import_media' && args.import_id === undefined))
      && args.files === undefined && args.source === undefined) {
    throw new ToolInputError('Provide native host attachments in files'
      + (name === 'analyze' ? ', or select existing media with source. ' : ' to start an import. ')
      + 'Native descriptors contain file_id and a temporary authorized HTTPS download_url; videos do not need public publishing. '
      + (context.transportMode === 'stdio' ? 'For local files, use source.file_paths within configured upload roots.'
        : 'Hosted tools cannot read local or sandbox paths. Ask the user to attach files through a host that forwards them.'));
  }
  const local = context.transportMode === 'stdio';
  const oauth = context.authenticationKind === 'oauth';
  const variant = `${local}:${oauth}`;
  let catalog = catalogs.get(variant);
  if (!catalog) { catalog = getValidationToolDefinitions({ includeLocalUpload: local, advertiseOAuth: oauth }); catalogs.set(variant, catalog); }
  const tool = catalog.find(item => item.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  const checked = validator.getValidator(tool.inputSchema)(args);
  if (!checked.valid) throw new ToolInputError(`Invalid ${name} arguments: ${checked.errorMessage}`);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function payload(result: McpToolResponse): Record<string, unknown> { return result.structuredContent ?? {}; }
function updateResult(result: McpToolResponse, changes: Record<string, unknown>): McpToolResponse {
  const data = { ...payload(result), ...changes };
  return { ...result, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}
async function notifyProgress(context: WorkflowToolContext, message: string, completed?: number, total?: number): Promise<void> {
  if (context.signal?.aborted) return;
  try { await context.onProgress?.(message, completed, total); } catch { /* Progress delivery is advisory. */ }
}
async function facadeCall(client: VideoVectorClient, name: ToolName, args: Record<string, unknown>, options: Parameters<VideoVectorClient['mcpTool']>[2], context: WorkflowToolContext): Promise<McpToolResponse> {
  const waits = (name === 'get_analysis' || (name === 'import_media' && args.import_id !== undefined)) && args.wait_seconds !== 0;
  const timer = waits && context.onProgress ? setInterval(() => {
    void notifyProgress(context, 'Waiting for an updated processing state. Durable work continues.');
  }, 10000) : undefined;
  try { return await client.mcpTool(name, args, options); } finally { if (timer) clearInterval(timer); }
}
async function progress(result: McpToolResponse, context: WorkflowToolContext): Promise<void> {
  if (context.signal?.aborted) return;
  const data = payload(result); const counts = record(data.progress);
  if (typeof data.message === 'string') await notifyProgress(context, data.message, typeof counts.completed === 'number' ? counts.completed : undefined, typeof counts.total === 'number' ? counts.total : undefined);
}
function uncertainSubmission(error: unknown): boolean {
  return !(error instanceof VideoVectorApiError) || (error.code !== 'idempotency_key_reused' && (
    error.statusCode >= 500 || [408, 409, 429, 499].includes(error.statusCode)
    || ['network_error', 'timeout_error', 'empty_response', 'invalid_json_response'].includes(error.code)
  ));
}
function submissionReceipt(name: string, idempotencyKey: string): McpToolResponse {
  const data = {
    error: true, code: `${name}_submission_unconfirmed`, recoverable: true,
    message: `The submission response was not confirmed; work may already be accepted. Repeat ${name} with identical arguments and the returned idempotency_key. Do not start new work or invent an ID.`,
    next_action: { type: 'retry_same_submission', tool: name, idempotency_key: idempotencyKey, after_seconds: 15 },
  };
  return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function readFailure(name: string, error: unknown, args: Record<string, unknown>, context: WorkflowToolContext): McpToolResponse {
  const formatted = formatError(error, { authenticationKind: context.authenticationKind });
  const data = record(JSON.parse(formatted.content[0]!.text));
  const ids = Object.fromEntries(['analysis_id', 'import_id', 'search_id', 'video_id', 'cursor', 'outputs_cursor', 'failures_cursor'].filter(key => typeof args[key] === 'string').map(key => [key, args[key]]));
  const observation = (name === 'get_analysis' && (ids.analysis_id || ids.video_id))
    || (name === 'import_media' && ids.import_id && args.retry !== true)
    || (name === 'search' && ids.search_id);
  if (observation && !context.signal?.aborted && error instanceof VideoVectorApiError && ['network_error', 'timeout_error'].includes(error.code)) {
    data.message = 'This observation was interrupted. Repeat the same read with the same identifiers and cursor; do not submit new work.';
    data.suggestion = `Continue with ${name} using the original arguments after the indicated delay.`;
    data.next_action = { type: 'continue_polling', tool: name, after_seconds: 15 };
  }
  return { ...formatted, structuredContent: { ...data, ...ids }, content: [{ type: 'text', text: JSON.stringify({ ...data, ...ids }) }] };
}
async function intake(name: 'analyze' | 'import_media', args: Record<string, unknown>, client: VideoVectorClient, context: WorkflowToolContext): Promise<McpToolResponse> {
  const continuation = name === 'import_media' && typeof args.import_id === 'string';
  if (continuation) {
    try {
      const observed = await facadeCall(client, name, args, { signal: context.signal, deadline: context.deadline ?? Date.now() + 30000, idempotencyKey: args.idempotency_key as string | undefined }, context);
      await progress(observed, context);
      return observed;
    } catch (error) {
      if (args.retry === true && uncertainSubmission(error)) return submissionReceipt(name, args.idempotency_key as string);
      return readFailure(name, error, args, context);
    }
  }
  const paths = record(args.source).file_paths as string[] | undefined;
  const authorized = await Promise.all((paths ?? []).map(path => authorizeUploadFile(path, context.uploadRoots ?? [])));
  const idempotencyKey = args.idempotency_key as string | undefined ?? `${name}:${randomUUID()}`;
  const request: Record<string, unknown> = { ...args, idempotency_key: idempotencyKey, wait_seconds: 0 };
  if (paths) delete request.source; // Authorized local uploads use the internal source-less grant admission.
  const waitSeconds = args.wait_seconds as number | undefined ?? 30;
  await notifyProgress(context, 'Receiving media', 0);
  let result: McpToolResponse;
  try {
    result = await client.mcpTool(name, request, { idempotencyKey, signal: context.signal, deadline: context.deadline ?? Date.now() + 30000 });
  } catch (error) {
    if (!uncertainSubmission(error)) throw error;
    return submissionReceipt(name, idempotencyKey);
  }
  if (result.isError) return result;
  const idField = name === 'analyze' ? 'analysis_id' : 'import_id';
  const id = payload(result)[idField];
  if (typeof id !== 'string' || !id) return submissionReceipt(name, idempotencyKey);
  let uploaded = !authorized.length;
  try {
    if (authorized.length) {
      const grant = result._meta?.upload as WorkflowUploadGrant | undefined;
      if (!grant) throw new VideoVectorApiError('Upload grant unavailable', 'upload_grant_unavailable', 409);
      client.validateUploadGrant(id, grant);
      const fileIds = authorized.map((_, index) => createHash('sha256').update(`${idempotencyKey}\0${index}`).digest('hex'));
      await uploadAttachmentBatch(authorized, async (file, index) => {
        context.signal?.throwIfAborted();
        await notifyProgress(context, `Uploading file ${index + 1} of ${authorized.length}`, index, authorized.length);
        await client.workflowUploadAttachment(id, grant, file.filePath, fileIds[index]!, file.identity, context.signal);
      });
      await client.workflowCompleteAttachments(id, grant, fileIds, context.signal, Date.now() + 30000);
      uploaded = true;
    }
    const next = record(payload(result).next_action);
    if (uploaded && (authorized.length || next.type === 'continue_polling') && (waitSeconds > 0 || authorized.length)) {
      const observed = await facadeCall(client, name === 'analyze' ? 'get_analysis' : 'import_media',
        { [idField]: id, wait_seconds: waitSeconds, ...(args.detail === undefined ? {} : { detail: args.detail }) },
        { signal: context.signal, deadline: Date.now() + 30000 }, context);
      const observedData = payload(observed);
      const retryableObservation = observedData[idField] === id
        && record(observedData.next_action).type === 'continue_polling'
        && ['observation_unavailable', 'network_error', 'timeout_error'].includes(String(observedData.code));
      if (!observed.isError || retryableObservation) result = observed;
      else {
        result = updateResult(result, { message: 'Work was accepted, but reading its status needs attention. Retain the same task ID.', next_action: { type: 'review_error' } });
        result.isError = true;
        result.oauthAuthenticationFailure = observed.oauthAuthenticationFailure;
      }
    }
  } catch (error) {
    const attention = error instanceof VideoVectorApiError && error.statusCode >= 400 && error.statusCode < 500 && ![408, 409, 429, 499].includes(error.statusCode);
    const formatted = attention ? formatError(error, { authenticationKind: uploaded ? context.authenticationKind : undefined }) : undefined;
    const message = formatted ? record(JSON.parse(formatted.content[0]!.text)).message : undefined;
    result = updateResult(result, {
      message: uploaded
        ? `Work was accepted. ${typeof message === 'string' ? message : 'This observation ended before a newer status was available.'} Read the same ${idField}; do not restart work.`
        : `Work was accepted but local upload is incomplete. Retry identical arguments using the same idempotency_key.`,
      next_action: !uploaded ? { type: 'retry_same_submission', tool: name, idempotency_key: idempotencyKey, after_seconds: 15 }
        : attention ? { type: 'review_error' } : { type: 'continue_polling', after_seconds: 15 },
    });
    if (attention) { result.isError = true; result.oauthAuthenticationFailure = formatted?.oauthAuthenticationFailure; }
  }
  await progress(result, context);
  return result;
}
export function isWorkflowTool(name: string): name is ToolName { return Object.values(TOOL_NAMES).includes(name as ToolName); }
export async function executeWorkflowTool(name: string, args: Record<string, unknown>, client: VideoVectorClient, context: WorkflowToolContext = {}): Promise<McpToolResponse> {
  try {
    validateArguments(name, args, context);
    if (name === 'analyze' || name === 'import_media') return await intake(name, args, client, context);
    const mutation = name === 'save_prompt' || (name === 'search' && args.search_id === undefined && args.cursor === undefined);
    const idempotencyKey = mutation ? args.idempotency_key as string | undefined ?? `${name}:${randomUUID()}` : undefined;
    const request = idempotencyKey ? { ...args, idempotency_key: idempotencyKey } : args;
    try {
      const result = await facadeCall(client, name as ToolName, request, { idempotencyKey, signal: context.signal, deadline: context.deadline ?? Date.now() + 30000 }, context);
      await progress(result, context);
      return result;
    } catch (error) {
      if (mutation && idempotencyKey && uncertainSubmission(error)) return submissionReceipt(name, idempotencyKey);
      return readFailure(name, error, args, context);
    }
  } catch (error) { return formatError(error, { authenticationKind: context.authenticationKind }); }
}
