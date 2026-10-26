import { afterEach, describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { VideoVectorClient } from '../src/client/index.js';
import { VideoVectorApiError } from '../src/types/index.js';
import { executeTool, getToolDefinitions, getToolDefinition, getToolRequiredScope } from '../src/tools/index.js';
const names = ['analyze','get_analysis','search','import_media','save_prompt','browse'];
const data = { analysis_id:'analysis-1',status:'processing',stage:'extracting',message:'One video complete',scope:{type:'videos',video_ids:['video-1','video-2']},progress:{total:2,imported:2,completed:1,failed:0},results:{included_videos:1,final:false,download_url:'https://api.example/results?token=grant',expires_in_seconds:3600},next_action:{type:'continue_polling',after_seconds:15} };
const response = (value: Record<string, unknown> = data, meta = {}) => ({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value,_meta:meta});
function client() { return { mcpTool:vi.fn().mockResolvedValue(response()) } as unknown as VideoVectorClient; }
const parse = (result:any) => result.structuredContent ?? JSON.parse(result.content[0].text);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('single six-tool facade', () => {
  it('publishes identical names on both transports and OAuth, with no profile or aliases', () => {
    for(const includeLocalUpload of [true,false]) for(const advertiseOAuth of [true,false]) expect(getToolDefinitions({includeLocalUpload,advertiseOAuth}).map(t=>t.name)).toEqual(names);
    for(const name of ['find','process_media','list_indexes','list_analyses','upload_media','get_import_job','retry_import_job','get_export_status','cancel_prompt_run']) expect(getToolDefinition(name)).toBeUndefined();
  });
  it('keeps public required scopes and import observation scope precise', () => {
    expect(names.map(name=>getToolRequiredScope(name))).toEqual(['write','read','search','write','write','read']);
    expect(getToolRequiredScope('import_media',{import_id:'i'})).toBe('read');
    expect(getToolRequiredScope('import_media',{import_id:'i',retry:true})).toBe('write');
  });
  it.each(['api-key','oauth'] as const)('passes one canonical structured response unchanged for %s',async authenticationKind=>{
    const backend=client(); const result=response(data); vi.mocked(backend.mcpTool).mockResolvedValue(result);
    const out=await executeTool('analyze',{instruction:'Describe',source:{video_ids:['video-1']},wait_seconds:0},backend,{authenticationKind});
    expect(out).toEqual(result);expect(out.structuredContent!.results).not.toHaveProperty('revision');
    expect(backend.mcpTool).toHaveBeenCalledExactlyOnceWith('analyze',expect.objectContaining({source:{video_ids:['video-1']},wait_seconds:0,idempotency_key:expect.any(String)}),expect.objectContaining({idempotencyKey:expect.any(String),deadline:expect.any(Number)}));
  });
  it('admits once then observes the same identity and emits progress',async()=>{
    const backend=client(); const onProgress=vi.fn();await executeTool('analyze',{prompt_id:'p',source:{index_id:'i'},execution:{enable_image_embedding:false}},backend,{onProgress});
    expect(vi.mocked(backend.mcpTool).mock.calls.map(c=>c[0])).toEqual(['analyze','get_analysis']);
    expect(vi.mocked(backend.mcpTool).mock.calls[1][1]).toEqual({analysis_id:'analysis-1',wait_seconds:30});
    expect(onProgress).toHaveBeenCalledWith('One video complete',1,2);
  });
  it.each(['timeout_error','network_error'] as const)('returns the exact submission key on uncertain %s and never silently submits twice',async code=>{
    const backend=client();vi.mocked(backend.mcpTool).mockRejectedValue(new VideoVectorApiError('private',code,0));
    const out=await executeTool('analyze',{instruction:'Describe',source:{video_ids:['video-1']},idempotency_key:'same'},backend);
    expect(parse(out).next_action).toEqual({type:'retry_same_submission',tool:'analyze',idempotency_key:'same',after_seconds:15});expect(backend.mcpTool).toHaveBeenCalledTimes(1);
  });
  it('retains accepted identity after observation timeout without another submission',async()=>{
    const backend=client();vi.mocked(backend.mcpTool).mockResolvedValueOnce(response()).mockRejectedValueOnce(new VideoVectorApiError('private','timeout_error',408));
    const out=await executeTool('analyze',{instruction:'Describe',source:{video_ids:['video-1']}},backend);expect(parse(out)).toMatchObject({analysis_id:'analysis-1',next_action:{type:'continue_polling'}});expect(backend.mcpTool).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['get_analysis',{analysis_id:'a',detail:'full',cursor:'page-2'}],
    ['get_analysis',{video_id:'v'}],
    ['import_media',{import_id:'i',outputs_cursor:'outputs-2',failures_cursor:'failures-2',wait_seconds:0}],
    ['search',{search_id:'s',cursor:'page-2',page_size:5}],
  ] as const)('directs interrupted %s observations to the original read without hidden retries',async(name,args)=>{
    for (const code of ['network_error','timeout_error']) {
      const backend=client();vi.mocked(backend.mcpTool).mockRejectedValue(new VideoVectorApiError('private socket token',code,code==='timeout_error'?408:0));
      const out=await executeTool(name,args,backend);
      const expectedIds=Object.fromEntries(Object.entries(args).filter(([key])=>['analysis_id','video_id','import_id','search_id','cursor','outputs_cursor','failures_cursor'].includes(key)));
      expect(parse(out)).toMatchObject({...expectedIds,code,next_action:{type:'continue_polling',tool:name,after_seconds:15}});
      if (!('analysis_id' in args)) expect(parse(out)).not.toHaveProperty('analysis_id');
      expect(JSON.stringify(out)).not.toContain('private socket token');
      expect(backend.mcpTool).toHaveBeenCalledExactlyOnceWith(name,args,expect.objectContaining({idempotencyKey:undefined}));
    }
  });
  it('returns same-analysis continuation after a real API response stream interruption without replaying its POST',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,text:async()=>{throw new TypeError('terminated');}});vi.stubGlobal('fetch',fetch);
    const backend=new VideoVectorClient({apiKey:'synthetic-key',baseUrl:'https://api.example/api/v2'});
    const args={analysis_id:'a',wait_seconds:0};
    const out=await executeTool('get_analysis',args,backend);
    expect(parse(out)).toMatchObject({analysis_id:'a',code:'network_error',next_action:{type:'continue_polling',tool:'get_analysis',after_seconds:15}});
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.example/api/v2/workflow/mcp/get_analysis',expect.objectContaining({method:'POST',body:JSON.stringify(args)}));
  });
  it('does not continue observing when cancellation coincides with a network failure',async()=>{
    const backend=client();const cancelled=new AbortController();
    vi.mocked(backend.mcpTool).mockImplementation(async()=>{cancelled.abort();throw new VideoVectorApiError('terminated','network_error',0);});
    const out=await executeTool('get_analysis',{analysis_id:'a'},backend,{signal:cancelled.signal});
    expect(parse(out)).toMatchObject({analysis_id:'a',next_action:{type:'review_error'}});expect(backend.mcpTool).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['analyze',{instruction:'Describe',source:{video_ids:['video-1']}},'analysis_id','analysis-1','get_analysis'],
    ['import_media',{files:[{file_id:'file-1',download_url:'https://files.example/video'}]},'import_id','import-1','import_media'],
  ] as const)('preserves the same-task actionable observation receipt after %s admission',async(name,args,idField,id,readTool)=>{
    const backend=client();const accepted=response({[idField]:id,next_action:{type:'continue_polling'}});
    const unavailable={...response({[idField]:id,code:'observation_unavailable',message:'Read this same task.',next_action:{type:'continue_polling',tool:readTool,after_seconds:15}}),isError:true};
    vi.mocked(backend.mcpTool).mockResolvedValueOnce(accepted).mockResolvedValueOnce(unavailable);
    expect(await executeTool(name,args,backend)).toEqual(unavailable);
    expect(vi.mocked(backend.mcpTool).mock.calls.map(call=>call[0])).toEqual([name,readTool]);
    expect(vi.mocked(backend.mcpTool).mock.calls[1][1]).toEqual({[idField]:id,wait_seconds:30});
  });
  it('rejects a different-task observation receipt after admission',async()=>{
    const backend=client();vi.mocked(backend.mcpTool).mockResolvedValueOnce(response()).mockResolvedValueOnce({...response({analysis_id:'different',code:'observation_unavailable',next_action:{type:'continue_polling'}}),isError:true});
    expect(parse(await executeTool('analyze',{instruction:'Describe',source:{video_ids:['video-1']}},backend))).toMatchObject({analysis_id:'analysis-1',next_action:{type:'review_error'}});
    expect(backend.mcpTool).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['invalid_api_key',401,'request_input'],['authorization_denied',403,'request_input'],['request_cancelled',499,'review_error'],
  ] as const)('keeps %s outside automatic observation recovery',async(code,status,nextAction)=>{
    const backend=client();vi.mocked(backend.mcpTool).mockRejectedValue(new VideoVectorApiError('private',code,status));
    const out=await executeTool('get_analysis',{analysis_id:'a'},backend);
    expect(parse(out)).toMatchObject({analysis_id:'a',next_action:{type:nextAction}});expect(backend.mcpTool).toHaveBeenCalledTimes(1);
  });
  it.each([['get_analysis',{analysis_id:'a'}],['import_media',{import_id:'i'}],['search',{search_id:'s'}]] as const)('retains read identity and typed auth guidance for %s',async(name,args)=>{
    const backend=client();vi.mocked(backend.mcpTool).mockRejectedValue(new VideoVectorApiError('private','invalid_api_key',401));const out=await executeTool(name,args,backend);expect(parse(out)).toMatchObject({...args,next_action:{type:'request_input'}});expect(backend.mcpTool).toHaveBeenCalledTimes(1);
  });
  it.each([['search',{query:'red car',scope:{index_name:'Clips'},max_results:50,page_size:5}],['save_prompt',{instruction:'Describe',save:false}],['browse',{resource:'analyses',index_id:'i',status:'completed'}]] as const)('forwards canonical %s arguments without native alias dispatch',async(name,args)=>{
    const backend=client();await executeTool(name,args,backend);expect(backend.mcpTool).toHaveBeenCalledExactlyOnceWith(name,expect.objectContaining(args),expect.any(Object));
  });
  it('continues a saved search with its identity and optional cursor without a new submission key',async()=>{const backend=client();await executeTool('search',{search_id:'s',cursor:'next',page_size:5},backend);expect(backend.mcpTool).toHaveBeenCalledExactlyOnceWith('search',{search_id:'s',cursor:'next',page_size:5},expect.objectContaining({idempotencyKey:undefined}));});
  it('retries imports only with explicit identity and keeps that receipt on uncertainty',async()=>{
    const backend=client();vi.mocked(backend.mcpTool).mockRejectedValue(new Error('network'));const out=await executeTool('import_media',{import_id:'i',retry:true,idempotency_key:'retry-same'},backend);expect(parse(out).next_action).toMatchObject({type:'retry_same_submission',idempotency_key:'retry-same'});
  });
  it.each(['api-key', 'oauth'] as const)('renews only explicit failed-import attachment descriptors for %s', async authenticationKind => {
    const backend = client();
    const args = { import_id: 'i', retry: true, idempotency_key: 'renew-same', files: [{ file_id: 'original-file', download_url: 'https://files.example/fresh' }] };
    await executeTool('import_media', args, backend, { authenticationKind, transportMode: 'http' });
    expect(backend.mcpTool).toHaveBeenCalledExactlyOnceWith('import_media', args, expect.objectContaining({ idempotencyKey: 'renew-same' }));
    for (const replacement of [{ destination: { index_id: 'other' } }, { title: 'changed' }, { source: { file_paths: ['other'] } }]) {
      vi.mocked(backend.mcpTool).mockClear();
      expect((await executeTool('import_media', { ...args, ...replacement }, backend, { authenticationKind, transportMode: 'http' })).isError).toBe(true);
      expect(backend.mcpTool).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['analyze',{instruction:'x',prompt_id:'p'}],['analyze',{instruction:'x',video_ids:['v']}],['analyze',{instruction:'x',files:[{file_id:'f',download_url:'https://x'}],source:{video_ids:['v']}}],
    ['analyze',{instruction:'x',source:{video_ids:['v']},destination:{index_id:'i'}}],['analyze',{instruction:'x',source:{index_id:'i',index_name:'n'}}],
    ['get_analysis',{analysis_id:'a',after_revision:'private'}],['get_analysis',{analysis_id:'a',cursor:'c'}],['search',{query:'x'}],['search',{cursor:'c'}],['search',{search_id:'s',query:'x'}],['search',{query:'x',scope:{analysis_ids:['a'],video_ids:['v']}}],
    ['import_media',{import_id:'i',files:[{file_id:'f',download_url:'https://x'}]}],['import_media',{import_id:'i',retry:true}],['save_prompt',{instruction:'x',definition:{name:'p',prompt_text:'p',json_schema:{}}}],['browse',{resource:'indexes',status:'completed'}],['browse',{resource:'videos',include_defaults:true}],
  ])('rejects invalid %s combinations before backend access',async(name,args)=>{const backend=client();const out=await executeTool(name as string,args as Record<string,unknown>,backend);expect(out.isError).toBe(true);expect(parse(out).next_action.type).toBe('correct_arguments');expect(backend.mcpTool).not.toHaveBeenCalled();});
  it('emits bounded-wait progress only for opted-in hosts and clears the timer',async()=>{
    vi.useFakeTimers();const backend=client();let finish!:(value:any)=>void;vi.mocked(backend.mcpTool).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const onProgress=vi.fn();
    const pending=executeTool('get_analysis',{analysis_id:'a',wait_seconds:30},backend,{onProgress});
    await vi.advanceTimersByTimeAsync(10000);expect(onProgress).toHaveBeenCalledWith('Waiting for an updated processing state. Durable work continues.',undefined,undefined);
    finish(response());await pending;const count=onProgress.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(onProgress).toHaveBeenCalledTimes(count);expect(backend.mcpTool).toHaveBeenCalledTimes(1);
  });
  it('does not turn a progress delivery failure into a duplicate or failed submission',async()=>{const backend=client();const out=await executeTool('analyze',{instruction:'x',source:{video_ids:['video-1']},wait_seconds:0},backend,{onProgress:vi.fn().mockRejectedValue(new Error('host closed'))});expect(out.isError).not.toBe(true);expect(backend.mcpTool).toHaveBeenCalledTimes(1);});
  it('validates every advertised example in each transport and authentication schema',()=>{const validator=new AjvJsonSchemaValidator();for(const includeLocalUpload of [true,false])for(const advertiseOAuth of [true,false])for(const tool of getToolDefinitions({includeLocalUpload,advertiseOAuth})){const validate=validator.getValidator(tool.inputSchema);for(const example of tool.inputSchema.examples as unknown[])expect(validate(example).valid,tool.name).toBe(true);}});
});
