import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoVectorClient } from '../src/client/index.js';
import { executeTool } from '../src/tools/index.js';

const baseUrl = 'https://example.com/api/v2';
const grant = {
  url: `${baseUrl}/workflow/attachments/analysis-1/files`,
  complete_url: `${baseUrl}/workflow/attachments/analysis-1/complete`,
  token: 'upload-grant', expires_at: '2030-01-01T00:00:00Z', max_files: 8, accept: 'video/*',
};
const admitted = {
  analysis_id: 'analysis-1', status: 'awaiting_upload', stage: 'awaiting_upload', message: 'Upload media',
  scope: { type: 'playground' }, progress: { total: 1, imported: 0, completed: 0, failed: 0 },
  results: { revision: 'empty', included_videos: 0, final: false, download_url: null, expires_in_seconds: null },
  next_action: { type: 'request_input' }, upload: grant,
};
const completed = {
  ...admitted, upload: undefined, status: 'completed', stage: 'completed', message: 'Done',
  progress: { total: 1, imported: 1, completed: 1, failed: 0 },
  results: { ...admitted.results, revision: 'complete', included_videos: 1, final: true },
  next_action: { type: 'download_and_answer' },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function response(data: Record<string, unknown>) { const {upload,...value}=data; return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value,_meta:upload?{upload}:undefined}; }
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('stdio analysis upload budgets', () => {
  it('finishes a 45-second streamed upload and starts a fresh observation after finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-slow-upload-'));
    const path = join(root, 'clip.mp4');
    const bytes = Buffer.alloc(256 * 1024, 'v');
    await writeFile(path, bytes);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const startedAt = Date.now();
    const uploadStarted = deferred();
    const completionStarted = deferred();
    const observationStarted = deferred();
    let uploadSignal!: AbortSignal;
    let receivedBytes = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === `${baseUrl}/workflow/mcp/analyze`) return json(response(admitted));
      if (url === grant.url) {
        uploadSignal = init.signal!;
        const slowTransfer = delay(45000, uploadSignal);
        uploadStarted.resolve();
        await slowTransfer;
        for await (const chunk of init.body as unknown as Readable) receivedBytes += Buffer.byteLength(chunk);
        return json({ job_id: 'analysis-1', status: 'awaiting_upload' });
      }
      if (url === grant.complete_url) {
        const finalize = delay(20000, init.signal!);
        completionStarted.resolve();
        await finalize;
        return json({ job_id: 'analysis-1', status: 'pending' });
      }
      expect(url).toBe(`${baseUrl}/workflow/mcp/get_analysis`);expect(JSON.parse(init.body as string).wait_seconds).toBe(30);
      const observation = delay(28000, init.signal!);
      observationStarted.resolve();
      await observation;
      return json(response(completed));
    });
    vi.stubGlobal('fetch', fetch);
    const client = new VideoVectorClient({ apiKey: 'test', baseUrl, timeout: 90000, maxRetries: 0 });
    const read = vi.spyOn(client, 'mcpTool');
    try {
      const pending = executeTool('analyze', { instruction: 'Describe', source: { file_paths: [path] }, idempotency_key: 'same-upload' }, client, {
        transportMode: 'stdio', uploadRoots: [root], deadline: startedAt + 30000,
      });
      await uploadStarted.promise;
      await vi.advanceTimersByTimeAsync(31000);
      expect(uploadSignal.aborted).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(14000);
      await completionStarted.promise;
      expect(receivedBytes).toBeGreaterThan(bytes.length);
      await vi.advanceTimersByTimeAsync(20000);
      await observationStarted.promise;
      expect(read).toHaveBeenLastCalledWith('get_analysis', {analysis_id:'analysis-1',wait_seconds:30},{signal:undefined,deadline:startedAt+95000});
      await vi.advanceTimersByTimeAsync(28000);
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ analysis_id: 'analysis-1', status: 'completed' });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['configured timeout', 'host cancellation'] as const)('ends an unfinished transfer on %s without finalizing or resubmitting', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-stopped-upload-'));
    const path = join(root, 'clip.mp4');
    await writeFile(path, 'video');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const startedAt = Date.now();
    const uploadStarted = deferred();
    const controller = new AbortController();
    let uploadSignal!: AbortSignal;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === `${baseUrl}/workflow/mcp/analyze`) return json(response(admitted));
      expect(url).toBe(grant.url);
      uploadSignal = init.signal!;
      const unfinishedTransfer = delay(90000, uploadSignal);
      uploadStarted.resolve();
      await unfinishedTransfer;
      throw new Error('Transfer should have been interrupted');
    });
    vi.stubGlobal('fetch', fetch);
    const client = new VideoVectorClient({ apiKey: 'test', baseUrl, timeout: 40000, maxRetries: 0 });
    const complete = vi.spyOn(client, 'workflowCompleteAttachments');
    const read = vi.spyOn(client, 'mcpTool');
    try {
      const pending = executeTool('analyze', { instruction: 'Describe', source: { file_paths: [path] }, idempotency_key: 'same-upload' }, client, {
        transportMode: 'stdio', uploadRoots: [root], signal: controller.signal, deadline: startedAt + 30000,
      });
      await uploadStarted.promise;
      await vi.advanceTimersByTimeAsync(31000);
      expect(uploadSignal.aborted).toBe(false);
      if (reason === 'host cancellation') controller.abort();
      else await vi.advanceTimersByTimeAsync(9000);
      const result = await pending;
      expect(uploadSignal.aborted).toBe(true);
      expect(result.structuredContent).toMatchObject({
        analysis_id: 'analysis-1', next_action: { type: 'retry_same_submission', idempotency_key: 'same-upload' },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(complete).not.toHaveBeenCalled();
      expect(read.mock.calls.map(c=>c[0])).toEqual(['analyze']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts observation after a slow durable admission for existing media', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const client = new VideoVectorClient({ apiKey: 'test', baseUrl });
    const read=vi.spyOn(client,'mcpTool').mockImplementation(async name=>{
      if(name==='analyze'){await new Promise(resolve=>setTimeout(resolve,20000));return response({...admitted,upload:undefined,status:'processing',next_action:{type:'continue_polling'}});}
      return response(completed);
    });
    const pending = executeTool('analyze', { instruction: 'Describe', source: { video_ids: ['video-1'] } }, client, {
      deadline: startedAt + 30000,
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect((await pending).structuredContent).toMatchObject({ status: 'completed' });
    expect(read).toHaveBeenLastCalledWith('get_analysis',{analysis_id:'analysis-1',wait_seconds:30},{signal:undefined,deadline:startedAt+50000});
  });
});
