import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';
import { artifactLink, appOrigin, projectWorkflowPayload, projectWorkflowResult, resultLink } from '../src/tools/workflow-result-projection.js';
import { WORKFLOW_RESULT_TOOLS, WORKFLOW_DETAIL_TOOLS, RESULTS_CARD_URI } from '../src/tools/workflow-result-contract.js';
import * as resultView from '../ui/results-view';
import { createStudioTransport, normalizeStudioResult } from '../ui/results-search';
import { getSearchResultKey } from '../ui/utils/searchResultIdentity';

const secret = 'https://storage.googleapis.com/private/clip.mp4?X-Goog-Signature=private-capability';
const row = { result_id: 'segment:seg-1:run-1', result_type: 'segment', run_id: 'run-1', video_id: 'video-1', segment_id: 'seg-1', video_name: 'Launch', start_time: 4, end_time: 9, metadata: { scene: 'x'.repeat(200000), gcs_uri: 'customer field' }, video_uri: secret, segment_uri: secret, raw_llm_response: 'private raw output', source_index_id: 'index-1' };
const cursor = 'opaque/'.repeat(100);
const runPage = { run_id: 'run-1', status: 'completed', result_level: 'segment', destination: { type: 'index', index_id: 'index-1' }, selection_summary: { status: 'ready', selected_segment_count: 1, selected_media_count: 1, selected_video_count: 1 }, filtered: { data: [row], pagination: { limit: 10, has_more: true, next_cursor: cursor } }, unfiltered: { data: [row], pagination: { limit: 10, has_more: false, next_cursor: null } } };
function client(overrides = {}): VideoVectorClient {
  return {
    workflowRunResults: vi.fn().mockResolvedValue(runPage),
    workflowDelivery: vi.fn().mockResolvedValue({ source_kind: 'prompt_run', source_id: 'run-1', artifacts: [
      { scope: 'all', state: 'ready', export_id: 'export-1', format_version: 2, download_path: '/private/raw', href: secret, raw: 'private' },
      { scope: 'matches', state: 'preparing', format_version: 2 },
      { scope: 'invalid', state: 'ready', href: secret },
    ] }),
    ...overrides,
  } as unknown as VideoVectorClient;
}

describe('workflow result contract v2', () => {
  it.each(['api-key', 'oauth'] as const)('bounds default summaries and mirrors text/structured results for %s', async authenticationKind => {
    const result = await executeTool('get_prompt_run_results', { run_id: 'run-1' }, client(), { authenticationKind });
    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent!;
    expect(JSON.parse(result.content[0]!.text)).toEqual(payload);
    expect(result.content[0]!.text.length).toBeLessThan(6000);
    expect(result.content[0]!.text).not.toContain('private-capability');
    expect(result.content[0]!.text).not.toContain('private raw output');
    expect(payload).toMatchObject({ contract_version: 2, detail: 'summary', selection_summary: runPage.selection_summary,
      filtered: { data: [{ metadata_fields: ['scene', 'gcs_uri'], metadata_field_count: 2, metadata_omitted: true }], pagination: { next_cursor: cursor } },
      artifacts: [{ scope: 'all', state: 'ready', export_id: 'export-1' }, { scope: 'matches', state: 'preparing' }],
    });
    expect((payload.filtered as any).data[0].links.play).toContain('/index?');
    expect((payload.links as any).open_in_app).toContain('video=video-1');
    expect((payload.artifacts as any[])[0].href).toBe('https://app.vectormethods.com/jobs?tab=exports&export=export-1&source_kind=prompt_run&source_id=run-1&scope=all');
    expect(JSON.stringify(payload.artifacts)).not.toContain('download_path');
  });

  it('budgets useful summary previews across both pages, including multi-byte metadata', () => {
    const data = Array.from({ length: 50 }, (_, index) => ({ ...row, result_id: String(index), metadata: { scene: 'Visible café 🚀 '.repeat(200) }, text_content: 'Scene details '.repeat(80) }));
    const projected = projectWorkflowPayload('get_prompt_run_results', { ...runPage, filtered: { data, pagination: runPage.filtered.pagination }, unfiltered: { data, pagination: runPage.unfiltered.pagination } }, 'summary');
    const rows = [...(projected.filtered as any).data, ...(projected.unfiltered as any).data];
    expect(rows[0].metadata_preview).toContain('Visible café');
    expect(rows[0].metadata_preview.length).toBeLessThanOrEqual(512);
    expect(rows.reduce((sum, item) => sum + Buffer.byteLength(item.metadata_preview ?? '') + Buffer.byteLength(item.content ?? ''), 0)).toBeLessThanOrEqual(8192);
    expect(rows.at(-1)).toMatchObject({ metadata_preview: '', metadata_omitted: true, content_omitted: true });
  });

  it('preserves complete canonical public fields in full mode and uses a valid landing without a video', () => {
    const raw = { ...row, text_content: 'complete '.repeat(4000), content_preview: 'short', metadata_text: 'metadata text', raw_llm_response: 'full generated response', field_scores: { scene: 0.9 } };
    const projected = projectWorkflowPayload('search_media', { data: [raw], pagination: {} }, 'full');
    expect((projected.data as any)[0]).toMatchObject({ content: raw.text_content, text_content: raw.text_content, content_preview: 'short', metadata_text: 'metadata text', raw_llm_response: 'full generated response', field_scores: { scene: 0.9 } });
    expect((projected.data as any)[0]).not.toHaveProperty('segment_uri');
    const pending = projectWorkflowPayload('get_prompt_run_status', { run_id: 'run-1', status: 'pending' }, 'summary');
    expect((pending.links as any).open_in_app).toContain('/jobs?tab=exports&');
    const processing = projectWorkflowPayload('process_media', { run_id: 'run-1', run: { run_context: { video_ids: ['video-2'], index_id: 'index-2' } } }, 'summary');
    expect((processing.links as any).open_in_app).toContain('/index?index=index-2&view=video&video=video-2');
    expect(resultLink({ video_id: 'video-1', result_type: 'video', preview_segment_id: 'seg-1' }, 'run-1', 'all', appOrigin())).toContain('output=video');
  });

  it('rejects non-string presentation controls before backend execution', async () => {
    const backend = client();
    const result = await executeTool('get_prompt_run_results', { run_id: 'run-1', detail: ['full'] }, backend);
    expect(result.isError).toBe(true);
    expect(backend.workflowRunResults).not.toHaveBeenCalled();
  });

  it('opens whole media from processing and status without requiring video-level analysis', () => {
    for (const tool of ['process_media', 'get_prompt_run_status']) {
      const run = { status: 'completed', run_context: { video_ids: ['video-1'], is_playground: true } };
      const payload = projectWorkflowPayload(tool, { run_id: 'run-1', ...(tool === 'process_media' ? { run } : run) }, 'summary');
      const url = new URL((payload.links as any).open_in_app);
      expect(url.pathname).toBe('/playground');
      expect(url.searchParams.get('video')).toBe('video-1');
      expect(url.searchParams.get('run')).toBe('run-1');
      expect(url.searchParams.get('playback')).toBe('video');
      expect(url.searchParams.has('output')).toBe(false);
    }
  });

  it.each(['find', 'upload_media', 'get_import_job', 'retry_import_job'])('exposes imported media directly from %s before and after a run exists', tool => {
    for (const runId of [undefined, 'run-1']) for (const indexId of [undefined, 'index-1']) {
      const payload = projectWorkflowPayload(tool, { job_id: 'job-1', status: 'completed', video_ids: ['video-1'], run_id: runId, target_index_id: indexId }, 'summary');
      const url = new URL((payload.links as any).watch_video);
      expect(url.pathname).toBe(indexId ? '/index' : '/playground');
      expect(url.searchParams.get('video')).toBe('video-1');
      expect(url.searchParams.get('run')).toBe(runId ?? null);
      expect(url.searchParams.get('index')).toBe(indexId ?? null);
      expect(url.searchParams.get('playback')).toBe('video');
      expect(url.searchParams.has('output')).toBe(false);
      if (runId) expect((payload.links as any).open_in_app).toBe(url.href);
      else expect((payload.links as any).open_in_app).toContain('/jobs?tab=imports&job=job-1');
    }
  });

  it.each(['api-key', 'oauth'] as const)('fails closed on malformed public pages for %s', async authenticationKind => {
    for (const malformed of [
      null, [], { ...runPage, unfiltered: undefined },
      { ...runPage, filtered: { data: 'not-an-array', pagination: {} } },
      { ...runPage, filtered: { data: [{ ...row, metadata: secret }], pagination: {} } },
      { ...runPage, filtered: { data: [{ ...row, video_id: null }], pagination: {} } },
    ]) {
      const backend = client({ workflowRunResults: vi.fn().mockResolvedValue(malformed) });
      const result = await executeTool('get_prompt_run_results', { run_id: 'run-1', detail: 'full' }, backend, { authenticationKind });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]!.text).not.toContain('private-capability');
      expect(backend.workflowDelivery).not.toHaveBeenCalled();
    }
    const search = await executeTool('search_media', { query: 'scene' }, client({ workflowSearchMedia: vi.fn().mockResolvedValue({ data: [{ result_id: 'result', video_id: 'video' }], pagination: {} }) }), { authenticationKind });
    expect(search.isError).toBe(true); // Never make a link that silently chooses a newer run.
  });

  it('rejects malformed JSON content without exposing it or private metadata', async () => {
    const result = await projectWorkflowResult('search_media', {
      content: [{ type: 'text', text: `not-json ${secret}` }], _meta: { private: secret },
    }, 'summary', client());
    expect(result).toMatchObject({ isError: true });
    expect(result._meta).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).code).toBe('workflow_result_projection_failed');
    expect(JSON.stringify(result)).not.toContain('private-capability');
  });

  it('projects full status settings without private run context and preserves exact navigation', () => {
    const payload = projectWorkflowPayload('get_prompt_run_status', {
      run_id: 'logical-run', status: 'completed', billing_error: secret,
      configuration: { video_segment_duration: 12, processing_model: 'model',
        run_context: { is_playground: true, index_id: 'internal-owner', video_ids: ['video-1'],
          extraction_source_by_video: { 'video-1': 'physical-run' }, artifact_delivery: { token: secret }, active_attempt_id: 'private-attempt' },
        provider_options: { url: secret },
      },
      operations: { field_extraction: { succeeded: true, failures: 0, provider_url: secret } },
      media_breakdown: { videos: { completed: 1, private: secret } },
      reuse_summary: { reused_media_count: 1, physical_run_id: 'physical-run' },
    }, 'full');
    expect(payload.configuration).toEqual({ video_segment_duration: 12, processing_model: 'model', run_context: { is_playground: true, video_ids: ['video-1'] } });
    expect(payload.operations).toEqual({ field_extraction: { succeeded: true, failures: 0 } });
    expect(payload.media_breakdown).toEqual({ videos: { completed: 1 } });
    expect(payload.reuse_summary).toEqual({ reused_media_count: 1 });
    const url = new URL((payload.links as any).open_in_app);
    expect(url.pathname).toBe('/playground');
    expect(url.searchParams.get('run')).toBe('logical-run');
    for (const privateValue of ['private-capability', 'private-attempt', 'physical-run', 'internal-owner']) expect(JSON.stringify(payload)).not.toContain(privateValue);
  });

  it('keeps complete prompt definitions and logical source run aliases', () => {
    const name = 'complete-name '.repeat(100);
    const payload = projectWorkflowPayload('define_prompt', { saved: true, prompt: { name, description: name, json_schema: { properties: { gcs_uri: { type: 'string' } } }, user_id: 'private-owner' } }, 'full');
    expect(payload.prompt).toMatchObject({ name, description: name });
    expect(payload.prompt).not.toHaveProperty('user_id');
    const page = projectWorkflowPayload('search_media', { data: [{ ...row, run_id: undefined, source_run_id: 'logical-run' }], pagination: {} }, 'full');
    expect(new URL((page.data as any[])[0].links.play).searchParams.get('run')).toBe('logical-run');
  });

  it('preserves actual processing overrides in full mode through the same public settings projection', () => {
    const payload = projectWorkflowPayload('process_media', {
      run_id: 'run-1', run: { status: 'pending', video_segment_duration: 24,
        video_segmentation_type: 'fixed', run_context: { video_ids: ['video-1'], index_id: 'index-1', active_attempt_id: 'private-attempt' } },
    }, 'full');
    expect(payload.configuration).toEqual({ video_segment_duration: 24, video_segmentation_type: 'fixed', run_context: { video_ids: ['video-1'], index_id: 'index-1' } });
    expect(JSON.stringify(payload)).not.toContain('private-attempt');
  });

  it.each(['summary', 'full'] as const)('retains canonical search scope and coverage in %s', detail => {
    const coverage = { prompt_run_count: 2, searchable_video_count: 3, partial_prompt_run_count: 1, requested_video_count: 4, covered_video_count: 3 };
    const scope = { type: 'videos', video_ids: ['video-1', 'video-2', 'video-3', 'video-4'] };
    const projected = projectWorkflowPayload('search_media', { data: [], pagination: {}, scope: { ...scope, physical_run_id: 'private' }, coverage }, detail);
    expect(projected.coverage).toEqual(coverage);
    expect(projected.scope).toEqual(scope);
  });

  it('keeps Studio destinations and identifiers exact, with a separate whole-video link', () => {
    const videoId = 'v'.repeat(256);
    const segmentId = 's'.repeat(256);
    for (const source of [
      { destination: { type: 'playground' }, run: { run_context: { video_ids: [videoId], index_id: 'account-owner' } } },
      { run: { configuration: { run_context: { video_ids: [videoId], index_id: 'account-owner', is_playground: true } } } },
    ]) {
      const payload = projectWorkflowPayload('process_media', { ...source, run_id: 'run-1' }, 'summary');
      const url = new URL((payload.links as any).open_in_app);
      expect(url.pathname).toBe('/playground');
      expect(url.searchParams.get('video')).toBe(videoId);
      expect(url.searchParams.has('index')).toBe(false);
    }
    const payload = projectWorkflowPayload('search_media', { data: [{ ...row, video_id: videoId, segment_id: segmentId }], pagination: {} }, 'summary');
    const result = (payload.data as any[])[0];
    expect(result.video_id).toBe(videoId);
    expect(result.segment_id).toBe(segmentId);
    expect(new URL(result.links.play).searchParams.get('segment')).toBe(segmentId);
    const videoLink = new URL(result.links.watch_video);
    expect(videoLink.searchParams.get('video')).toBe(videoId);
    expect(videoLink.searchParams.has('segment')).toBe(false);
    expect(videoLink.searchParams.has('t')).toBe(false);
    expect(videoLink.searchParams.has('output')).toBe(false);
    expect(videoLink.searchParams.get('playback')).toBe('video');
  });

  it('routes the canonical Playground search sentinel and run destination into Studio', () => {
    const search = projectWorkflowPayload('search_media', { data: [{ ...row, source_index_id: 'playground' }], pagination: {} }, 'summary');
    const results = projectWorkflowPayload('get_prompt_run_results', { ...runPage, destination: { type: 'playground' } }, 'summary');
    for (const result of [(search.data as any[])[0], ...(results.filtered as any).data, ...(results.unfiltered as any).data]) {
      for (const href of Object.values(result.links)) {
        const url = new URL(href as string);
        expect(url.pathname).toBe('/playground');
        expect(url.searchParams.get('step')).toBe('studio');
        expect(url.searchParams.has('index')).toBe(false);
      }
    }
  });

  it('keeps full JSON opt-in and independent cursors unchanged without reexecuting work', async () => {
    const backend = client();
    const summary = await executeTool('get_prompt_run_results', { run_id: 'run-1', view: 'filtered', filtered_cursor: cursor }, backend);
    const full = await executeTool('get_prompt_run_results', { run_id: 'run-1', view: 'filtered', filtered_cursor: cursor, detail: 'full' }, backend);
    expect(vi.mocked(backend.workflowRunResults).mock.calls[1]).toEqual(vi.mocked(backend.workflowRunResults).mock.calls[0]);
    expect((full.structuredContent!.filtered as any).data[0].metadata).toEqual(row.metadata);
    expect((summary.structuredContent!.filtered as any).data[0]).not.toHaveProperty('metadata');
    expect((full.structuredContent!.filtered as any).pagination.next_cursor).toBe(cursor);
    expect(full.content[0]!.text).not.toContain('private-capability');
  });

  it('strips detail before process idempotency and search cursor validation', async () => {
    const backend = client({ workflowProcessMedia: vi.fn().mockResolvedValue({ run_id: 'run-1', run: { status: 'pending' } }), workflowSearchPage: vi.fn().mockResolvedValue({ data: [], mode: 'vector', result_level: 'segment', snapshot_id: 'snapshot-1', pagination: { next_cursor: null } }) });
    for (const detail of ['summary', 'full']) await executeTool('process_media', { prompt_id: 'prompt-1', idempotency_key: 'same-key', detail }, backend);
    expect(vi.mocked(backend.workflowProcessMedia).mock.calls).toEqual([
      [{ prompt_id: 'prompt-1', artifact_delivery: 'automatic' }, 'same-key'],
      [{ prompt_id: 'prompt-1', artifact_delivery: 'automatic' }, 'same-key'],
    ]);
    const result = await executeTool('search_media', { cursor, detail: 'full' }, backend);
    expect(result.isError).not.toBe(true);
    expect(backend.workflowSearchPage).toHaveBeenCalledWith(cursor);
  });

  it('publishes the same versioned contract for all nine workflow names and narrows detail to heavy outputs', () => {
    const validator = new AjvJsonSchemaValidator();
    for (const profile of ['simple', 'full'] as const) for (const local of [true, false]) {
      const definitions = getToolDefinitions(profile, local);
      for (const name of WORKFLOW_RESULT_TOOLS) {
        const tool = definitions.find(tool => tool.name === name)!;
        expect(Boolean(tool.inputSchema.properties?.detail)).toBe(WORKFLOW_DETAIL_TOOLS.has(name));
        const payload = projectWorkflowPayload(name, { job_id: 'job-1', status: 'pending', video_ids: [], run_id: 'run-1', run: { status: 'pending' }, prompt_id: 'prompt-1', data: [], pagination: {}, filtered: null, unfiltered: null }, 'summary');
        expect(validator.getValidator(tool.outputSchema!)(payload).valid, name).toBe(true);
      }
    }
    expect(getToolDefinitions('simple', false)).toHaveLength(9);
  });

  it('makes delivery lookup failure explicit while preserving the successful result', async () => {
    const result = await executeTool('get_prompt_run_results', { run_id: 'run-1' }, client({ workflowDelivery: vi.fn().mockRejectedValue(new Error(secret)) }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent!.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'all', state: 'unavailable', error_code: 'delivery_lookup_failed' })]));
    expect(result.content[0]!.text).not.toContain('private-capability');
  });

  it('supports the frontend navigation contract and rejects non-origin configuration', () => {
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/workflow-links.json', import.meta.url), 'utf8'));
    for (const item of fixtures.artifact_links) {
      const url = new URL(artifactLink(item.source_kind, item.source_id, item.scope, item.export_id, appOrigin()));
      const expected = new URL(item.pathname + item.search, appOrigin());
      expected.searchParams.delete('action');
      expect(url.pathname).toBe(expected.pathname);
      expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(expected.searchParams));
    }
    const url = new URL(resultLink({ video_id: 'video-2', source_index_id: 'index-1', result_type: 'video' }, 'run-2', 'matches', appOrigin()));
    expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(new URL(fixtures.result_links[1].pathname + fixtures.result_links[1].search, appOrigin()).searchParams));
    expect(() => appOrigin('https://user:secret@evil.example')).toThrow();
    expect(() => appOrigin('javascript:alert(1)')).toThrow();
    expect(() => appOrigin('https://app.example/path?token=secret')).toThrow();
  });
});

describe('results app tools', () => {
  it.each(['api-key', 'oauth'] as const)('keeps the original card scope and page only in private metadata for %s', async authenticationKind => {
    const request = { run_id: 'run-1', video_id: 'narrow-video', view: 'both', result_level: 'segment', limit: 7, filtered_cursor: 'current-matches', unfiltered_cursor: 'current-all', detail: 'summary' };
    const backend = client();
    const result = await executeTool('get_prompt_run_results', request, backend, { authenticationKind });
    expect(result.isError).not.toBe(true);
    expect(result._meta!.viewRequest).toEqual({ video_id: 'narrow-video', view: 'both', result_level: 'segment', limit: 7, filtered_cursor: 'current-matches', unfiltered_cursor: 'current-all' });
    expect((result._meta!.view as any).filtered.data[0].metadata).toEqual(row.metadata);
    expect(JSON.stringify([result.content, result.structuredContent])).not.toMatch(/narrow-video|current-matches|current-all|viewRequest/);
    expect(backend.workflowRunResults).toHaveBeenCalledWith('run-1', result._meta!.viewRequest);
  });

  it('retains private search decisions and exact continuation without exposing them to the model', async () => {
    const backend = client({ workflowSearchPage: vi.fn().mockResolvedValue({ snapshot_id: 'snapshot-1', data: [], pagination: { limit: 3, next_cursor: 'next' } }) });
    const result = await executeTool('search_media', { cursor: 'current-search-page', detail: 'full' }, backend);
    expect(result._meta!.viewRequest).toEqual({ limit: 3, cursor: 'current-search-page' });
    expect(JSON.stringify([result.content, result.structuredContent])).not.toContain('current-search-page');
    const firstPage = await executeTool('search_media', { query: 'visible scene', limit: 4, idempotency_key: 'search-retry' }, client({ workflowSearchMedia: vi.fn().mockResolvedValue({ snapshot_id: 'snapshot-1', data: [], pagination: { limit: 4 } }) }));
    expect(firstPage._meta!.viewRequest).toEqual({ limit: 4, query: 'visible scene' });
    expect(JSON.stringify([firstPage.content, firstPage.structuredContent])).not.toContain('visible scene');
  });

  it('publishes app-only helpers and attaches the results card only to result tools', () => {
    const tools = getToolDefinitions('simple', false, { includeAppTools: true });
    for (const name of ['view_workflow_results', 'play_workflow_media']) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool._meta).toMatchObject({ ui: { visibility: ['app'] }, 'openai/visibility': 'private' });
      expect(getToolRequiredScope(name)).toBe('read');
    }
    expect(RESULTS_CARD_URI).toBe('ui://videovector/results-card-v2.html');
    expect(tools.filter(tool => (tool._meta?.ui as any)?.resourceUri === RESULTS_CARD_URI).map(tool => tool.name)).toEqual(['search_media', 'get_prompt_run_results']);
  });

  it('loads full run pages only in private metadata', async () => {
    const backend = client();
    const result = await executeTool('view_workflow_results', { source_kind: 'prompt_run', source_id: 'run-1', filtered_cursor: 'next', view: 'filtered' }, backend, { authenticationKind: 'oauth' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(row.metadata.scene);
    expect((result._meta!.view as any).filtered.data[0].metadata).toEqual(row.metadata);
    expect(JSON.stringify(result._meta!.view)).not.toContain('private-capability');
    expect(backend.workflowRunResults).toHaveBeenCalledWith('run-1', expect.objectContaining({ filtered_cursor: 'next', view: 'filtered' }));
  });

  it('reads an existing snapshot without creating a new search', async () => {
    const backend = client({ workflowSnapshotResults: vi.fn().mockResolvedValue({ snapshot_id: 'snapshot-1', data: [row], pagination: { next_cursor: 'next' } }), workflowSearchMedia: vi.fn() });
    const result = await executeTool('view_workflow_results', { source_kind: 'search_snapshot', source_id: 'snapshot-1', cursor: 'next', limit: 10 }, backend);
    expect(result.isError).not.toBe(true);
    expect(backend.workflowSnapshotResults).toHaveBeenCalledWith('snapshot-1', { cursor: 'next', limit: 10 });
    expect(backend.workflowSearchMedia).not.toHaveBeenCalled();
  });

  it('returns only a private, ID-scoped playback grant and requires run membership for clips', async () => {
    const backend = client({ workflowMediaGrant: vi.fn().mockResolvedValue({ url: secret, expires_at: '2030-01-01T00:00:00Z', mime_type: 'video/mp4', start_time: 0, end_time: 5 }) });
    const result = await executeTool('play_workflow_media', { video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1' }, backend);
    expect(result._meta!.media).toMatchObject({ url: secret, start_time: 0, end_time: 5 });
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(secret);
    expect(backend.workflowMediaGrant).toHaveBeenCalledWith({ video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1' });
    const invalid = await executeTool('play_workflow_media', { video_id: 'video-1', segment_id: 'seg-1' }, backend);
    expect(invalid.isError).toBe(true);
    expect(backend.workflowMediaGrant).toHaveBeenCalledTimes(1);
  });
});

// Exercise the shipped handlers and canonical filtering without a browser.
const completePage = (rows: any[]) => ({ data: rows, pagination: { has_more: false, next_cursor: null } });
const cardRow = { ...row, metadata: { scene: 'Street', score: 7, vehicles: { visible: true } }, field_extraction_succeeded: true,
  links: { json: 'https://app.example/playground?video=video-1&run=run-1&metadata=json' } };
const laterRow = { ...cardRow, result_id: 'segment:seg-2:run-1', segment_id: 'seg-2', start_time: 9, end_time: 14, metadata: { scene: 'Park', score: 2, vehicles: { visible: false } } };
const videoRow = { ...cardRow, result_id: 'video:video-1:run-1', result_type: 'video', segment_id: undefined, metadata: { summary: 'City scenes', score: 8 } };
const cardPage = { ...runPage, selection_filter: { segment: { logic: 'and', conditions: [{ field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true }] } },
  filtered: completePage([cardRow]), unfiltered: completePage([cardRow, laterRow]) };
async function cardHarness(restored: any = null) {
  const elements = new Map<string, any>();
  function element() {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    return {
      hidden: false, disabled: false, textContent: '', className: '', readyState: 1, currentTime: 0, duration: 20, src: '',
      addEventListener: (name: string, callback: (...args: any[]) => unknown) => listeners.set(name, callback),
      fire: async (name: string) => listeners.get(name)?.(),
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }, getAttribute(name: string) { return name === 'src' ? this.src : undefined; },
      pause: vi.fn(), play: vi.fn(), load: vi.fn(),
    };
  }
  const document = { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const defaultResponse = async (request: any): Promise<any> => request.name === 'play_workflow_media'
    ? request.arguments.intent === 'download'
      ? { _meta: { file: { url: secret, name: 'media.mp4', mimeType: 'video/mp4' } } }
      : { _meta: { media: { url: secret, expires_at: '2030-01-01T00:00:00Z' } } }
    : request.arguments.result_level === 'video'
      ? { _meta: { view: { ...cardPage, result_level: 'video', filtered: completePage([videoRow]), unfiltered: completePage([videoRow]) },
        context: { run: { run_id: 'run-1', status: 'completed', prompt_name: 'Scene engine' }, video: { video_id: 'video-1', title: 'Launch' }, video_level_output: { video_id: 'video-1', run_id: 'run-1', status: 'successful', metadata: videoRow.metadata } } } }
      : { _meta: { view: cardPage } };
  const callServerTool = vi.fn(defaultResponse);
  let studioProps: any;
  const views = { ...resultView, createStudioTransport, normalizeStudioResult, getSearchResultKey, readStudioState: () => restored, saveStudioState: vi.fn(), createStudioSearchHost: () => ({ update: (props: any) => {
    studioProps = props; const p = props.segmentProps;
    views.renderSegments(document.getElementById('rows'), p.rows, p.selected, p.onSelect, p.label, p.range, p.downloadMedia, p.downloadMetadata);
  }, unmount: vi.fn() }), renderMetadata: vi.fn(), renderSegments: vi.fn(), renderTimeline: vi.fn(), renderToolbar: vi.fn(), renderDownloads: vi.fn() };
  class App {
    callServerTool = callServerTool;
    connect = vi.fn().mockResolvedValue(undefined);
    openLink = vi.fn().mockResolvedValue({});
    getHostCapabilities = vi.fn().mockReturnValue({ downloadFile: {} });
    downloadFile = vi.fn().mockResolvedValue({});
  }
  const source = readFileSync(new URL('../ui/results-card.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const app = await new AsyncFunction('App', 'document', ...Object.keys(views), `${source}\nreturn app;`)(App, document, ...Object.values(views));
  const receive = (value: any = cardPage, request: any = { video_id: 'video-1', view: 'both' }) => app.ontoolresult({ structuredContent: { ...value, source_kind: 'prompt_run', source_id: 'run-1' }, _meta: { view: value, viewRequest: request } });
  return { app, receive, callServerTool, defaultResponse, ...views, studio: () => studioProps, control: document.getElementById,
    mediaCalls: () => callServerTool.mock.calls.filter(([request]) => request.name === 'play_workflow_media'),
    viewCalls: () => callServerTool.mock.calls.filter(([request]) => request.name === 'view_workflow_results'),
    toolbar: () => views.renderToolbar.mock.lastCall![1], tiles: () => views.renderSegments.mock.lastCall![1] };
}

describe('results card Studio behavior', () => {
  it('keeps the frozen search carousel while loading the exact hit execution and returning to Studio', async () => {
    const card = await cardHarness();
    await card.receive();
    card.studio().onSearch();
    expect(card.studio().mode).toBe('results');
    const hit = { ...laterRow, run_id: 'run-2', result_id: 'segment:seg-2:run-2', field_scores: { scene: 0.8 }, similarity_score: 0.8 };
    const sibling = { ...cardRow, run_id: 'run-2', result_id: 'segment:seg-1:run-2' };
    card.callServerTool.mockImplementation(async request => request.name === 'view_workflow_results' && request.arguments.source_id === 'run-2'
      ? { _meta: { view: { ...cardPage, run_id: 'run-2', selection_filter: null, selection_summary: { status: 'not_applicable' }, unfiltered: completePage(request.arguments.result_level === 'video' ? [] : [sibling, hit]), filtered: null }, context: { run: { run_id: 'run-2' }, video: { video_id: 'video-1' } } } }
      : card.defaultResponse(request));
    await card.studio().onSelectResult(hit, [cardRow, hit]);
    expect(card.studio().mode).toBe('result');
    expect(card.tiles()).toEqual([sibling, expect.objectContaining({ result_id: hit.result_id, field_scores: { scene: 0.8 } })]);
    expect(card.control('toolbar').hidden).toBe(true);
    expect(card.studio().state.selectedResultKey).toBe(getSearchResultKey(hit));
    await card.control('back-results').fire('click');
    expect(card.studio().mode).toBe('results');
    expect(card.studio().searchResults).toEqual([cardRow, hit]);
    card.studio().onExit();
    expect(card.studio().mode).toBe('studio');
    expect(card.studio().segmentProps.selected.result_id).toBe(cardRow.result_id);
  });

  it('opens search tool snapshots as a grid without requesting playback or starting another search', async () => {
    const card = await cardHarness();
    const value = { snapshot_id: 'snap', source_kind: 'search_snapshot', source_id: 'snap', data: [cardRow], pagination: {} };
    await card.app.ontoolresult({ structuredContent: value, _meta: { view: value, viewRequest: { query: 'street', video_ids: ['video-1'], filters: [{ field: 'score', operator: 'greater_than', value: 3 }] } } });
    expect(card.studio()).toMatchObject({ mode: 'results', searchMounted: true, state: { snapshotId: 'snap', query: 'street', semanticWindowFiltered: true } });
    expect(card.mediaCalls()).toHaveLength(0);
    expect(card.callServerTool).not.toHaveBeenCalled();
  });

  it('restores the exact ordinary Studio segment after host remount without changing the search snapshot', async () => {
    const restored = { mode: 'studio', selected: { video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-2', result_id: laterRow.result_id }, search: { videoIds: ['video-1'], query: 'park', filters: [], snapshotId: 'saved-search', loadedPageCursors: [null] } };
    const card = await cardHarness(restored);
    await card.receive();
    expect(card.studio()).toMatchObject({ mode: 'studio', state: restored.search, segmentProps: { selected: laterRow } });
    expect(card.control('player').currentTime).toBe(9);
    expect(card.mediaCalls()).toHaveLength(1);
    expect(card.callServerTool.mock.calls.every(([request]) => request.name !== 'search_media')).toBe(true);
  });

  it('restores unprocessed media by video identity without inventing an execution', async () => {
    const card = await cardHarness({ mode: 'studio', selected: { video_id: 'fresh-video', result_id: 'media:fresh-video', media_type: 'video' }, search: { videoIds: null, query: '', filters: [] } });
    await card.receive();
    expect(card.studio().segmentProps.selected.video_id).toBe('fresh-video');
    expect(card.mediaCalls()[0][0].arguments).toEqual({ video_id: 'fresh-video' });
    expect(card.viewCalls()).toHaveLength(0);
  });

  it('preloads paused playback and video analysis, defaults engine matches on, and removes superseded controls', async () => {
    const card = await cardHarness();
    await card.receive();
    expect(card.control('player')).toMatchObject({ hidden: false, src: secret, currentTime: 4 });
    expect(card.control('player').play).not.toHaveBeenCalled();
    expect(card.toolbar()).toMatchObject({ mode: 'matches', visibleCount: 1, complete: true });
    expect(card.tiles()).toEqual([cardRow]);
    expect(card.viewCalls()).toEqual([[{ name: 'view_workflow_results', arguments: { source_kind: 'prompt_run', source_id: 'run-1', video_id: 'video-1', result_level: 'video', view: 'both', limit: 50, include_context: true } }]]);
    expect(card.renderMetadata).toHaveBeenCalledWith(card.control('video-analysis'), videoRow.metadata, videoRow.result_id, 'Video analysis');
    const html = readFileSync(new URL('../ui/results-card.html', import.meta.url), 'utf8');
    expect(html).toContain('id="studio-video-rail"');
    expect(html).not.toContain('video-picker');
    expect(html).not.toMatch(/id="(?:options|refresh|scope|level|play|artifacts)"|Retry playback|Metadata JSON/);
  });

  it('applies canonical text and nested conditions locally and preserves AND/OR semantics', async () => {
    const card = await cardHarness();
    await card.receive();
    const calls = card.callServerTool.mock.calls.length;
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([cardRow, laterRow]);
    card.toolbar().onChange({ resultSearchTerm: 'park' });
    expect(card.tiles()).toEqual([laterRow]);
    card.toolbar().onChange({ resultSearchTerm: '', resultFilter: { segment: { logic: 'or', conditions: [
      { field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true },
      { field: 'score', type: 'number', operator: 'less_than', value: 3 },
    ] } } });
    expect(card.tiles()).toEqual([cardRow, laterRow]);
    card.toolbar().onChange({ resultFilter: { segment: { logic: 'and', conditions: [
      { field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true },
      { field: 'score', type: 'number', operator: 'less_than', value: 3 },
    ] } } });
    expect(card.tiles()).toEqual([]);
    expect(card.control('empty').hidden).toBe(false);
    expect(card.callServerTool).toHaveBeenCalledTimes(calls);
  });

  it('keeps zero matches truthful while loading the original media and allowing engine filtering to be disabled', async () => {
    const card = await cardHarness();
    const page = { ...cardPage, selection_summary: { status: 'ready', selected_segment_count: 0 }, filtered: completePage([]) };
    await card.receive(page);
    expect(card.toolbar().mode).toBe('matches');
    expect(card.tiles()).toEqual([]);
    expect(card.control('player').hidden).toBe(false);
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([cardRow, laterRow]);
  });

  it('preloads all current-video pages from filtered-only input in canonical order without fetching other videos', async () => {
    const card = await cardHarness();
    const first = { ...cardRow, result_id: 'first', segment_id: 'seg-0', start_time: 0, end_time: 4 };
    const last = { ...laterRow, result_id: 'last', segment_id: 'seg-3', start_time: 14, end_time: 20 };
    const initial = { ...cardPage, unfiltered: null, filtered: completePage([cardRow]) };
    card.callServerTool.mockImplementation(async request => {
      if (request.name !== 'view_workflow_results' || request.arguments.result_level === 'video') return card.defaultResponse(request);
      return { _meta: { view: { ...cardPage, unfiltered: request.arguments.unfiltered_cursor
        ? completePage([laterRow, last]) : { data: [first, cardRow], pagination: { has_more: true, next_cursor: 'next-all' } } } } };
    });
    await card.receive(initial, { video_id: 'video-1', view: 'filtered' });
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([first, cardRow, laterRow, last]);
    expect(card.viewCalls().every(([request]) => request.arguments.video_id === 'video-1')).toBe(true);
    expect(card.viewCalls().some(([request]) => request.arguments.unfiltered_cursor === 'next-all')).toBe(true);
    expect(card.toolbar().complete).toBe(true);
  });

  it('preserves authored multi-video tiles and loads another video only when selected', async () => {
    const card = await cardHarness();
    const other = { ...laterRow, video_id: 'video-2', result_id: 'other' };
    card.callServerTool.mockImplementation(async request => {
      if (request.arguments.video_id !== 'video-2' || request.name !== 'view_workflow_results') return card.defaultResponse(request);
      return { _meta: { view: { ...cardPage, result_level: 'video', filtered: completePage([]), unfiltered: completePage([]) }, context: { run: { run_id: 'run-1' }, video: { video_id: 'video-2', title: 'Other' }, video_level_output: null } } };
    });
    await card.receive({ ...cardPage, filtered: completePage([cardRow, other]), unfiltered: completePage([cardRow, other]) }, { view: 'both' });
    expect(card.tiles()).toContainEqual(other);
    expect(card.viewCalls().every(([request]) => request.arguments.video_id === 'video-1')).toBe(true);
    await card.renderSegments.mock.lastCall![3](other);
    expect(card.viewCalls().some(([request]) => request.arguments.video_id === 'video-2')).toBe(true);
  });

  it('retains a rapid same-row timeline seek while its one media grant is pending', async () => {
    const card = await cardHarness();
    let resolveMedia!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveMedia = resolve; });
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media' ? pending : card.defaultResponse(request));
    const initial = card.receive();
    const first = card.renderTimeline.mock.lastCall![4](cardRow, 5.25);
    const last = card.renderTimeline.mock.lastCall![4](cardRow, 7.75);
    resolveMedia({ _meta: { media: { url: secret, expires_at: '2030-01-01T00:00:00Z' } } });
    await Promise.all([initial, first, last]);
    expect(card.mediaCalls()).toHaveLength(1);
    expect(card.control('player').currentTime).toBe(7.75);
    expect(card.control('player').play).not.toHaveBeenCalled();
  });

  it('uses canonical timeline clamping so filtered gaps never seek before the selected segment', () => {
    const later = { ...laterRow, start_time: 20, end_time: 25 };
    expect(resultView.resolveTimelineSelection([cardRow, later], 0)).toEqual({ row: cardRow, time: 4 });
    expect(resultView.resolveTimelineSelection([cardRow, later], 15)).toEqual({ row: cardRow, time: 9 });
    expect(resultView.resolveTimelineSelection([cardRow, later], 20)).toEqual({ row: later, time: 20 });
  });

  it.each(['image', undefined])('renders images from media type or grant MIME without video playback (%s)', async mediaType => {
    const card = await cardHarness();
    const image = { ...cardRow, media_type: mediaType };
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media'
      ? Promise.resolve({ _meta: { media: { url: secret, mime_type: 'image/png', expires_at: '2030-01-01T00:00:00Z' } } }) : card.defaultResponse(request));
    await card.receive({ ...cardPage, filtered: completePage([image]), unfiltered: completePage([image]) });
    expect(card.control('image-preview')).toMatchObject({ hidden: false, src: secret });
    expect(card.control('player').hidden).toBe(true);
    expect(card.control('timeline').hidden).toBe(true);
    await card.app.onteardown();
    expect(card.control('image-preview')).toMatchObject({ hidden: true, src: '' });
  });

  it('automatically refreshes a failed media grant once, then exposes a real error without retry controls', async () => {
    const card = await cardHarness();
    await card.receive();
    await card.control('player').fire('error');
    await Promise.resolve(); await Promise.resolve();
    expect(card.mediaCalls()).toHaveLength(2);
    await card.control('player').fire('error');
    expect(card.mediaCalls()).toHaveLength(2);
    expect(card.control('status').textContent).toContain('could not load');
  });

  it('downloads selected clip, full video and tile metadata through user-clicked native host actions', async () => {
    const card = await cardHarness();
    await card.receive();
    await card.renderSegments.mock.lastCall![6](cardRow);
    expect(card.mediaCalls().at(-1)![0].arguments).toMatchObject({ video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1', intent: 'download' });
    await card.renderDownloads.mock.lastCall![1]();
    expect(card.mediaCalls().at(-1)![0].arguments).toEqual({ video_id: 'video-1', run_id: 'run-1', intent: 'download' });
    await card.renderSegments.mock.lastCall![7](cardRow);
    const resource = card.app.downloadFile.mock.lastCall![0].contents[0].resource;
    const output = JSON.parse(resource.text);
    expect(output.segment.metadata).toEqual(cardRow.metadata);
    expect(output.segment.segment_index).toBe(1);
    expect(resource.text).not.toContain('private-capability');
    expect(card.app.openLink).not.toHaveBeenCalled();
  });

  it('downloads all analysis and video synthesis independently of current filters and automatic artifact readiness', async () => {
    const card = await cardHarness();
    await card.receive({ ...cardPage, artifacts: [{ scope: 'all', state: 'unavailable' }] });
    card.toolbar().onChange({ resultSearchTerm: 'does not match' });
    const calls = card.callServerTool.mock.calls.length;
    await card.renderDownloads.mock.lastCall![2]();
    const resource = card.app.downloadFile.mock.lastCall![0].contents[0].resource;
    const output = JSON.parse(resource.text);
    expect(output.prompt_runs[0].segments.map((item: any) => item.segment_id)).toEqual(['seg-1', 'seg-2']);
    expect(output.prompt_runs[0].video_level_output.metadata).toEqual(videoRow.metadata);
    expect(output.export_info).toMatchObject({ result_scope: 'all', source_kind: 'prompt_run', source_id: 'run-1' });
    expect(card.callServerTool).toHaveBeenCalledTimes(calls);
    expect(resource.text).not.toContain('private-capability');
  });

  it('restores exact snapshot continuation through the shared transport without rerunning search', async () => {
    const page = { source_kind: 'search_snapshot', source_id: 'snapshot-1', data: [cardRow], warnings: ['limited'], pagination: { has_more: false, next_cursor: null, result_window: 2, truncated: true } };
    const call = vi.fn().mockResolvedValue({ _meta: { view: page } });
    const transport = createStudioTransport(call);
    const restored = await transport.page({ snapshotId: 'snapshot-1', cursor: 'snapshot-next' });
    expect(call).toHaveBeenCalledExactlyOnceWith('view_workflow_results', { source_kind: 'search_snapshot', source_id: 'snapshot-1', cursor: 'snapshot-next', limit: 50 }, undefined);
    expect(restored).toMatchObject({ results: [normalizeStudioResult(cardRow)], snapshotId: 'snapshot-1', truncated: true, warnings: ['limited'], nextCursor: null });
  });

  it('shares the rail and search catalog read without cancelling the other consumer', async () => {
    let complete!: (value: any) => void;
    const call = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const transport = createStudioTransport(call);
    const controller = new AbortController();
    const first = transport.catalog({ signal: controller.signal });
    const second = transport.catalog({});
    controller.abort();
    complete({ _meta: { catalog: { videos: [{ video_id: 'v1' }], runs: [], fields: [], browse_targets: [] } } });
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0].status).toBe('rejected');
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { videos: [{ video_id: 'v1' }] } });
    expect(call).toHaveBeenCalledExactlyOnceWith('list_studio_scope', { limit: 100 }, undefined);
  });

  it('reuses an uncertain semantic attempt key, then assigns a new key after success', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue({ _meta: { view: { snapshot_id: 'snapshot-1', data: [], pagination: {} } } });
    const transport = createStudioTransport(call);
    const request = { videoIds: ['v2', 'v1'], query: 'scene', filters: [] };
    await expect(transport.search(request)).rejects.toThrow('disconnected');
    await transport.search(request);
    await transport.search(request);
    expect(call.mock.calls[0][1]).toEqual(call.mock.calls[1][1]);
    expect(call.mock.calls[2][1].idempotency_key).not.toBe(call.mock.calls[1][1].idempotency_key);
    expect(call.mock.calls[1][1]).toMatchObject({ video_ids: ['v1', 'v2'], query: 'scene', limit: 50 });
  });

  it('caps eager paging, reports partial loaded counts, and reads the remainder only for all-metadata download', async () => {
    const card = await cardHarness();
    let pageNumber = 0;
    const initial = { ...cardPage, filtered: null, unfiltered: null, selection_filter: null, selection_summary: { status: 'not_applicable' } };
    card.callServerTool.mockImplementation(async request => {
      if (request.name !== 'view_workflow_results') return card.defaultResponse(request);
      if (request.arguments.result_level === 'video') {
        const response = await card.defaultResponse(request);
        response._meta.view.selection_filter = null;
        response._meta.view.selection_summary = { status: 'not_applicable' };
        return response;
      }
      const item = { ...cardRow, result_id: `item-${++pageNumber}`, segment_id: `loaded-seg-${pageNumber}` };
      const page = { data: [item], pagination: { has_more: pageNumber < 22, next_cursor: pageNumber < 22 ? `page-${pageNumber}` : null } };
      return Promise.resolve({ _meta: { view: { ...initial, unfiltered: page } } });
    });
    await card.receive({ ...initial, unfiltered: { data: [cardRow], pagination: { has_more: true, next_cursor: 'initial' } } });
    expect(card.viewCalls()).toHaveLength(20);
    expect(card.toolbar().complete).toBe(false);
    await card.renderDownloads.mock.lastCall![2]();
    const output = JSON.parse(card.app.downloadFile.mock.lastCall![0].contents[0].resource.text);
    expect(output.prompt_runs[0].segments).toHaveLength(23);
    expect(card.toolbar().complete).toBe(true);
  });

  it('does not label failed or repeating pagination as a complete metadata download', async () => {
    const card = await cardHarness();
    const initial = { ...cardPage, unfiltered: { data: [cardRow], pagination: { has_more: true, next_cursor: 'same' } } };
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media' ? card.defaultResponse(request)
      : Promise.resolve({ _meta: { view: initial } }));
    await card.receive(initial);
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.downloadFile).not.toHaveBeenCalled();
    expect(card.control('status').className).toBe('error');
    expect(card.toolbar().complete).toBe(false);
  });

  it('opens the existing metadata destination on unsupported hosts and never auto-falls back after native cancellation', async () => {
    const card = await cardHarness();
    await card.receive();
    card.app.getHostCapabilities.mockReturnValue({});
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.openLink).toHaveBeenCalledExactlyOnceWith({ url: cardRow.links.json });
    card.app.openLink.mockClear(); card.app.getHostCapabilities.mockReturnValue({ downloadFile: {} });
    card.app.downloadFile.mockResolvedValueOnce({ isError: true });
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.openLink).not.toHaveBeenCalled();
    expect(card.control('status').textContent).toContain('cancelled');
  });
});
