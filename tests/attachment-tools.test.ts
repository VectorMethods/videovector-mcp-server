import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions } from '../src/tools/index.js';
import { attachmentPickerResource } from '../src/apps/attachment-picker.js';

const baseUrl = 'https://example.com/api/v2';
const grant = {
  url: `${baseUrl}/workflow/attachments/job_1/files`,
  complete_url: `${baseUrl}/workflow/attachments/job_1/complete`,
  token: 'private-upload-token', expires_at: '2030-01-01T00:00:00Z', max_files: 100, accept: 'video/*',
};
const queued = { job_id: 'job_1', status: 'pending', video_ids: ['video_1'], run_id: null };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared attachment intake', () => {
  it('publishes an MCP Apps resource and accepts pending jobs with nullable destinations and runs', () => {
    expect(attachmentPickerResource.mimeType).toBe('text/html;profile=mcp-app');
    const validator = new AjvJsonSchemaValidator();
    const pending = { ...queued, source_kind: 'attachments', status: 'awaiting_upload',
      target_index_id: null, error_message: null, progress: { total_files: 0, imported: 0 } };
    for (const name of ['find', 'upload_media', 'get_import_job', 'retry_import_job']) {
      const tool = getToolDefinitions('simple', false).find(tool => tool.name === name)!;
      const validate = validator.getValidator(tool.outputSchema!);
      const response = { ...pending, contract_version: 2, detail: 'summary', links: {}, artifacts: [] };
      expect(validate(response).valid).toBe(true);
      expect(validate({ ...response, run_id: 123 }).valid).toBe(false);
      expect(validate({ ...response, upload: grant }).valid).toBe(false);
    }
  });

  it('advertises native files on hosted tools and keeps local shortcuts in stdio only', () => {
    for (const name of ['find', 'upload_media']) {
      const hosted = getToolDefinitions('simple', false, { advertiseOAuth: true }).find(tool => tool.name === name)!;
      const local = getToolDefinitions('simple', true).find(tool => tool.name === name)!;
      expect(hosted._meta?.['openai/fileParams']).toEqual(['files']);
      expect(hosted.inputSchema.properties).not.toHaveProperty('file_path');
      expect(hosted.inputSchema.properties).not.toHaveProperty('file_paths');
      expect(local.inputSchema.properties).toHaveProperty(name === 'find' ? 'file_paths' : 'file_path');
      expect((hosted.inputSchema.properties?.files as any).items.required).toEqual(['download_url', 'file_id']);
    }
  });

  it('forwards native attachment descriptors unchanged and keeps the grant out of all model content', async () => {
    const client = new VideoVectorClient({ apiKey: 'test-key', baseUrl });
    const find = vi.spyOn(client, 'workflowFind').mockResolvedValue(queued);
    const files = [{ download_url: 'https://files.example/clip?cap=secret', file_id: 'host-file', file_name: 'clip.mp4' }];
    const result = await executeTool('find', { instruction: 'Find red cars', files, idempotency_key: 'command-1' }, client, { transportMode: 'http', authenticationKind: 'oauth' });
    expect(find).toHaveBeenCalledWith({ instruction: 'Find red cars', files, artifact_delivery: 'automatic' }, 'command-1');
    expect(result.structuredContent).toMatchObject({ ...queued, contract_version: 2, detail: 'summary' });
    vi.spyOn(client, 'workflowAttachments').mockResolvedValue({ ...queued, status: 'awaiting_upload', video_ids: [], upload: grant });
    const picker = await executeTool('upload_media', {}, client, { transportMode: 'http', authenticationKind: 'oauth' });
    expect(picker._meta?.upload).toEqual(grant);
    expect(JSON.stringify(picker.content) + JSON.stringify(picker.structuredContent)).not.toContain(grant.token);
    expect(picker.structuredContent).not.toHaveProperty('upload');
  });

  it.each(['api-key', 'oauth'] as const)('returns a successful attachment retry through %s with the API intake response', async authenticationKind => {
    const response = {
      job_id: 'att_failed_upload',
      source_kind: 'attachments',
      status: 'pending',
      video_ids: [],
      progress: { total_files: 1, imported: 0, failed: 0, bytes_transferred: 0 },
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    const result = await executeTool('retry_import_job', {
      job_id: response.job_id,
      idempotency_key: 'retry-same-attachment',
    }, client, { transportMode: 'http', authenticationKind });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`${baseUrl}/import-jobs/${response.job_id}/retry`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': 'retry-same-attachment' }),
    }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ...response, contract_version: 2, detail: 'summary' });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const retryTool = getToolDefinitions('simple', false).find(tool => tool.name === 'retry_import_job')!;
    const validate = new AjvJsonSchemaValidator().getValidator(retryTool.outputSchema!);
    expect(validate(result.structuredContent).valid).toBe(true);
  });

  it('refreshes only supplied descriptors through retry and advertises host files', async () => {
    const files = [{ file_id: 'sediment://file_1234', file_name: 'meeting.mp4', mime_type: 'video/mp4', download_url: 'https://files.example/meeting?cap=private' }];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(queued), { status: 202, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    const result = await executeTool('retry_import_job', { job_id: 'job_1', files, idempotency_key: 'refresh-1' }, client, { transportMode: 'http' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ files });
    expect(JSON.stringify(result)).not.toContain('cap=private');
    const tool = getToolDefinitions('simple', false).find(tool => tool.name === 'retry_import_job')!;
    expect(tool._meta?.['openai/fileParams']).toEqual(['files']);
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)({ job_id: 'job_1', files }).valid).toBe(true);
  });

  it('projects actionable attachment failures without reflecting download capabilities', async () => {
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    vi.spyOn(client, 'getImportJob').mockResolvedValue({ ...queued, status: 'failed', source_kind: 'attachments',
      failed_files: [{ path: 'sediment://file_1234', file_id: 'sediment://file_1234', file_name: 'meeting.mp4', error_code: 'attachment_refresh_required', error: 'https://files.example/meeting?cap=private', http_status: 403, refresh_required: true }], skipped_files: [], progress: { total_files: 3, imported: 2, failed: 1, skipped: 0, bytes_transferred: 100, current_file: null },
    } as any);
    const result = await executeTool('get_import_job', { job_id: 'job_1' }, client, { transportMode: 'http' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.failed_files).toEqual([expect.objectContaining({ path: 'meeting.mp4', file_id: 'sediment://file_1234', error_code: 'attachment_refresh_required', http_status: 403, refresh_required: true })]);
    expect(JSON.stringify(result)).not.toContain('cap=private');
    const tool = getToolDefinitions('simple', false).find(tool => tool.name === 'get_import_job')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(result.structuredContent).valid).toBe(true);
  });

  it.each([{ files: [] }, { files: [{ file_id: 'file', download_url: 'https://files.example/a', unsupported: true }] }])('rejects invalid refresh descriptors before a request', async ({ files }) => {
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    const retry = vi.spyOn(client, 'retryImportJob').mockResolvedValue(queued);
    const result = await executeTool('retry_import_job', { job_id: 'job_1', files }, client, { transportMode: 'http' });
    expect(result.isError).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  });

  it('stages authorized local paths with stable file identities and completes the exact batch', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcp-find-'));
    const paths = [join(root, 'one.mp4'), join(root, 'two.mp4')];
    await Promise.all(paths.map(path => fs.writeFile(path, 'video')));
    const client = new VideoVectorClient({ apiKey: 'test-key', baseUrl });
    vi.spyOn(client, 'workflowFind').mockResolvedValue({ ...queued, status: 'awaiting_upload', upload: grant });
    const stage = vi.spyOn(client, 'workflowUploadAttachment').mockResolvedValue(queued);
    const complete = vi.spyOn(client, 'workflowCompleteAttachments').mockResolvedValue(queued);
    try {
      for (let retry = 0; retry < 2; retry++) {
        const result = await executeTool('find', { instruction: 'Find red cars', file_paths: paths, idempotency_key: 'same-command' }, client, { transportMode: 'stdio', uploadRoots: [root] });
        expect(result.isError).not.toBe(true);
      }
      const firstIds = stage.mock.calls.slice(0, 2).map(call => call[3]);
      expect(stage.mock.calls.slice(2).map(call => call[3])).toEqual(firstIds);
      expect(complete).toHaveBeenLastCalledWith('job_1', grant, firstIds);
      expect(stage.mock.calls[0]?.[4]).toMatchObject({ size: 5 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('uploads bytes with only the scoped grant and sends exact file_ids at completion', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcp-attachment-'));
    const path = join(root, 'clip.mp4');
    await fs.writeFile(path, 'video-bytes');
    const stat = await fs.stat(path);
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chunks = [];
      if (typeof init.body === 'string') chunks.push(Buffer.from(init.body));
      else for await (const chunk of init.body as any) chunks.push(Buffer.from(chunk));
      requests.push({ url, headers: init.headers as Record<string, string>, body: Buffer.concat(chunks).toString() });
      return new Response(JSON.stringify(queued), { headers: { 'content-type': 'application/json' } });
    }));
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    try {
      await client.workflowUploadAttachment('job_1', grant, path, 'file-1', { device: stat.dev, inode: stat.ino, size: stat.size, modifiedMs: stat.mtimeMs });
      await client.workflowCompleteAttachments('job_1', grant, ['file-1']);
      expect(requests[0]?.body).toContain('video-bytes');
      expect(requests[0]?.body).toContain('name="file_id"\r\n\r\nfile-1');
      expect(JSON.parse(requests[1]!.body)).toEqual({ file_ids: ['file-1'] });
      for (const request of requests) {
        expect(request.headers.Authorization).toBe(`Bearer ${grant.token}`);
        expect(request.headers).not.toHaveProperty('X-API-Key');
      }
      expect(() => client.validateUploadGrant('job_1', { ...grant, url: 'https://other.example/upload' })).toThrow('Invalid attachment upload destination');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
