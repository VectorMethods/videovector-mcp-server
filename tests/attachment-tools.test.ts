import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions } from '../src/tools/index.js';

const baseUrl = 'https://example.com/api/v2';
const grant = {
  url: `${baseUrl}/workflow/attachments/job_1/files`,
  complete_url: `${baseUrl}/workflow/attachments/job_1/complete`,
  token: 'private-upload-token', expires_at: '2030-01-01T00:00:00Z', max_files: 8, accept: 'video/*',
};
const analysis = { analysis_id: 'job_1', status: 'completed', stage: 'completed', message: 'Done', scope: { type: 'playground' as const }, progress: { total: 8, imported: 8, completed: 8, failed: 0 }, results: { revision: 'r1', included_videos: 8, final: true, download_url: null, expires_in_seconds: null }, next_action: { type: 'download_and_answer' } };
const queued = { job_id: 'job_1', status: 'pending', video_ids: ['video_1'], run_id: null };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const response = (data: Record<string, unknown>, meta = {}) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, _meta: meta });
describe('shared attachment intake', () => {
  it('advertises root native files and nested stdio paths only on the matching transport',()=>{
    for(const name of ['analyze','import_media']){
      const hosted=getToolDefinitions({includeLocalUpload:false,advertiseOAuth:true}).find(t=>t.name===name)!;
      const local=getToolDefinitions({includeLocalUpload:true}).find(t=>t.name===name)!;
      expect(hosted._meta?.['openai/fileParams']).toEqual(['files']);expect((hosted.inputSchema.properties?.source as any)?.properties ?? {}).not.toHaveProperty('file_paths');
      expect((local.inputSchema.properties?.source as any).properties.file_paths.maxItems).toBe(8);
    }
  });
  it.each(['analyze', 'import_media'])('rejects missing media before hosted %s creates a job', async name => {
    for (const authenticationKind of ['oauth', 'api-key'] as const) {
      const client = new VideoVectorClient({ apiKey: 'test', baseUrl });
      const submit = vi.spyOn(client, 'mcpTool');
      const out = await executeTool(name, name === 'analyze' ? { instruction: 'Describe' } : { title: 'Attached video' }, client, { transportMode: 'http', authenticationKind });
      expect(out.isError).toBe(true);
      const error = JSON.parse(out.content[0].text);
      expect(error.next_action.type).toBe('correct_arguments');
      expect(error.message).toContain('temporary authorized HTTPS');
      expect(error.message).toContain('do not need public publishing');
      expect(submit).not.toHaveBeenCalled();
    }
  });
  it.each(['sandbox:/mnt/data/video.mp4', 'file:///tmp/video.mp4', 'http://files.example/video.mp4'])('rejects non-HTTPS native descriptor %s before admission', async download_url => {
    const client = new VideoVectorClient({ apiKey: 'test', baseUrl });
    const submit = vi.spyOn(client, 'mcpTool');
    const out = await executeTool('analyze', { instruction: 'Describe', files: [{ file_id: 'host-file', download_url }] }, client, { transportMode: 'http', authenticationKind: 'oauth' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).next_action.type).toBe('correct_arguments');
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['analyze','import_media'])('rejects a ninth file before %s admission',async name=>{
    const client=new VideoVectorClient({apiKey:'test',baseUrl});const submit=vi.spyOn(client,'mcpTool');
    const files=Array.from({length:9},(_,i)=>({file_id:String(i),download_url:`https://files.example/${i}`}));
    const out=await executeTool(name,{...(name==='analyze'?{instruction:'Describe'}:{}),files},client,{transportMode:'http'});expect(out.isError).toBe(true);expect(submit).not.toHaveBeenCalled();
  });
  it.each([
    {title:'Fallback title',files:[{file_id:'a',download_url:'https://files.example/a'},{file_id:'b',download_url:'https://files.example/b'}]},
  ])('retains title for native attachment batches',async args=>{
    const client=new VideoVectorClient({apiKey:'test',baseUrl});
    const submit=vi.spyOn(client,'mcpTool').mockResolvedValue(response({import_id:'job_1',status:'awaiting_upload',next_action:{type:'request_input'}},{upload:grant}));
    const out=await executeTool('import_media',args,client,{transportMode:'http',authenticationKind:'oauth'});
    expect(out.isError).not.toBe(true);
    expect(submit).toHaveBeenCalledWith('import_media',expect.objectContaining(args),expect.any(Object));
  });
  it.each([
    {connector_id:'cloud'},
    {connector:{provider:'gcs',config:{bucket:'bucket',gcp_project_id:'project',credentials_json:{type:'service_account'}}}},
  ])('rejects title only for unsupported cloud imports before admission',async source=>{const client=new VideoVectorClient({apiKey:'test',baseUrl});const submit=vi.spyOn(client,'mcpTool');const out=await executeTool('import_media',{title:'Fallback title',source},client,{transportMode:'stdio'});expect(out.isError).toBe(true);expect(JSON.parse(out.content[0].text).code).toBe('invalid_tool_input');expect(submit).not.toHaveBeenCalled();});
  it('retains the shared title when local paths become an authorized attachment batch',async()=>{
    const root=await fs.mkdtemp(join(tmpdir(),'mcp-import-title-'));
    const paths=['one','two'].map(name=>join(root,`${name}.mp4`));
    await Promise.all(paths.map(path=>fs.writeFile(path,'video')));
    const client=new VideoVectorClient({apiKey:'test',baseUrl});
    const submit=vi.spyOn(client,'mcpTool').mockResolvedValueOnce(response({import_id:'job_1',status:'awaiting_upload',next_action:{type:'request_input'}},{upload:grant})).mockResolvedValueOnce(response({import_id:'job_1',status:'completed',next_action:{type:'download_and_answer'}}));
    const stage=vi.spyOn(client,'workflowUploadAttachment').mockResolvedValue(queued);
    vi.spyOn(client,'workflowCompleteAttachments').mockResolvedValue(queued);
    try {
      const out=await executeTool('import_media',{title:'Fallback title',source:{file_paths:paths}},client,{transportMode:'stdio',uploadRoots:[root]});
      expect(out.isError).not.toBe(true);
      expect(submit.mock.calls[0]?.[1]).toMatchObject({title:'Fallback title'});
      expect(submit.mock.calls[0]?.[1]).not.toHaveProperty('source');
      expect(stage).toHaveBeenCalledTimes(2);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it('forwards host descriptors unchanged while keeping upload capabilities private',async()=>{
    const client=new VideoVectorClient({apiKey:'test',baseUrl});const submit=vi.spyOn(client,'mcpTool').mockResolvedValue(response({...analysis,status:'awaiting_upload',next_action:{type:'request_input'}},{upload:grant}));
    const files=[{file_id:'host-1',download_url:'https://host.example/file?cap=private',file_name:'clip.mp4',mime_type:'video/mp4'}];const out=await executeTool('analyze',{instruction:'Describe',files,idempotency_key:'same'},client,{transportMode:'http',authenticationKind:'oauth'});
    expect(submit).toHaveBeenCalledWith('analyze',expect.objectContaining({files}),expect.any(Object));expect(out._meta?.upload).toEqual(grant);expect(JSON.stringify(out.content)+JSON.stringify(out.structuredContent)).not.toContain(grant.token);
  });
  it('rejects local paths outside authorized roots before creating work',async()=>{
    const root=await fs.mkdtemp(join(tmpdir(),'mcp-roots-'));const outside=join(root,'outside.mp4');const inside=join(root,'allowed');await fs.mkdir(inside);await fs.writeFile(outside,'video');const client=new VideoVectorClient({apiKey:'test',baseUrl});const submit=vi.spyOn(client,'mcpTool');
    try { const out=await executeTool('analyze',{instruction:'Describe',source:{file_paths:[outside]}},client,{transportMode:'stdio',uploadRoots:[inside]});expect(out.isError).toBe(true);expect(submit).not.toHaveBeenCalled(); } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it('stages eight authorized local paths with stable file identities and completes the exact batch', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcp-find-'));
    const paths = Array.from({ length: 8 }, (_, index) => join(root, `${index}.mp4`));
    await Promise.all(paths.map(path => fs.writeFile(path, 'video')));
    const client = new VideoVectorClient({ apiKey: 'test-key', baseUrl });
    vi.spyOn(client, 'mcpTool').mockImplementation(async name => name === 'analyze' ? response({ ...analysis, status: 'awaiting_upload', next_action: { type: 'request_input' } }, { upload: grant }) : response(analysis));
    const stage = vi.spyOn(client, 'workflowUploadAttachment').mockResolvedValue(queued);
    const complete = vi.spyOn(client, 'workflowCompleteAttachments').mockResolvedValue(queued);
    try {
      for (let retry = 0; retry < 2; retry++) {
        const result = await executeTool('analyze', { instruction: 'Find red cars', source: { file_paths: paths }, idempotency_key: 'same-command' }, client, { transportMode: 'stdio', uploadRoots: [root] });
        expect(result.isError).not.toBe(true);
      }
      const firstIds = stage.mock.calls.slice(0, 8).map(call => call[3]);
      expect(firstIds).toHaveLength(8);
      expect(new Set(firstIds).size).toBe(8);
      expect(stage.mock.calls.slice(8).map(call => call[3])).toEqual(firstIds);
      expect(complete).toHaveBeenLastCalledWith('job_1', grant, firstIds, undefined, expect.any(Number));
      expect(stage.mock.calls[0]?.[4]).toMatchObject({ size: 5 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('settles a partial stdio failure before returning and retries the same batch identities', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcp-find-parallel-'));
    const paths = ['one', 'two', 'three'].map(name => join(root, `${name}.mp4`));
    await Promise.all(paths.map(path => fs.writeFile(path, 'video')));
    let fail!: (error: Error) => void;
    let finish!: () => void;
    let started!: () => void;
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const first = new Promise<void>((_resolve, reject) => { fail = reject; });
    const second = new Promise<void>(resolve => { finish = resolve; });
    const client = new VideoVectorClient({ apiKey: 'test-key', baseUrl });
    vi.spyOn(client, 'mcpTool').mockImplementation(async name => name === 'analyze' ? response({ ...analysis, status: 'awaiting_upload', next_action: { type: 'request_input' } }, { upload: grant }) : response(analysis));
    const stage = vi.spyOn(client, 'workflowUploadAttachment')
      .mockImplementationOnce(async () => { await first; return queued; })
      .mockImplementationOnce(async () => { started(); await second; return queued; });
    const complete = vi.spyOn(client, 'workflowCompleteAttachments').mockResolvedValue(queued);
    const args = { instruction: 'Find cars', source: { file_paths: paths }, idempotency_key: 'partial-batch' };
    const context = { transportMode: 'stdio' as const, uploadRoots: [root] };
    try {
      let returned = false;
      const pending = executeTool('analyze', args, client, context).then(result => { returned = true; return result; });
      await bothStarted;
      fail(new Error('first upload failed'));
      await Promise.resolve();
      await Promise.resolve();
      expect(stage).toHaveBeenCalledTimes(2);
      expect(returned).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      finish();
      expect((await pending).structuredContent?.next_action).toEqual({ type: 'retry_same_submission', tool: 'analyze', idempotency_key: 'partial-batch', after_seconds: 15 });
      const originalIds = stage.mock.calls.map(call => call[3]);
      stage.mockResolvedValue(queued);
      expect((await executeTool('analyze', args, client, context)).isError).not.toBe(true);
      const retryIds = stage.mock.calls.slice(2).map(call => call[3]);
      expect(retryIds.slice(0, 2)).toEqual(originalIds);
      expect(complete).toHaveBeenCalledExactlyOnceWith('job_1', grant, retryIds, undefined, expect.any(Number));
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
      return new Response(JSON.stringify(url === grant.url ? { job: queued, upload: { transport: 'resumable', url: 'https://storage.googleapis.com/upload/session', offset: 0, total_bytes: 11, chunk_size: 8 * 1024 * 1024 } } : queued), { headers: { 'content-type': 'application/json' } });
    }));
    const client = new VideoVectorClient({ apiKey: 'account-key', baseUrl });
    try {
      await client.workflowUploadAttachment('job_1', grant, path, 'file-1', { device: stat.dev, inode: stat.ino, size: stat.size, modifiedMs: stat.mtimeMs });
      await client.workflowCompleteAttachments('job_1', grant, ['file-1']);
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ file_id: 'file-1', size_bytes: 11 });
      expect(requests[1]?.body).toBe('video-bytes');
      expect(requests[1]?.headers).not.toHaveProperty('Authorization');
      expect(JSON.parse(requests[2]!.body)).toEqual({ file_id: 'file-1' });
      expect(JSON.parse(requests[3]!.body)).toEqual({ file_ids: ['file-1'] });
      for (const request of requests.filter(row => row.url.startsWith(baseUrl))) {
        expect(request.headers.Authorization).toBe(`Bearer ${grant.token}`);
        expect(request.headers).not.toHaveProperty('X-API-Key');
      }
      expect(() => client.validateUploadGrant('job_1', { ...grant, url: 'https://other.example/upload' })).toThrow('Invalid attachment upload destination');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
