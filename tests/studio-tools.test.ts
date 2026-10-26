import { describe, expect, it, vi } from 'vitest';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';
import { VideoVectorApiError } from '../src/types/index.js';
import type { VideoVectorClient } from '../src/client/index.js';

describe('Studio consumer tools', () => {
  it('exposes private read adapters alongside the single catalog', () => {
    {
      const definitions = getToolDefinitions({ includeAppTools: true });
      for (const name of ['list_studio_scope', 'get_studio_previews', 'read_analysis']) {
        expect(definitions.find(tool => tool.name === name)?._meta).toMatchObject({ ui: { visibility: ['app'] } });
        expect(getToolRequiredScope(name)).toBe('read');
      }
    }
    expect(getToolRequiredScope('search')).toBe('search');
  });

  it('loads exact video scope through canonical services and keeps the catalog private', async () => {
    const client = {
      workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [{ video_id: 'v1', run_id: 'r1' }], fields: [], coverage: {}, warnings: [] }),
      getPlaygroundVideos: vi.fn().mockResolvedValue({ data: [{ video_id: 'v1', title: 'Clip', user_id: 'private-owner', video_uri: 'https://private-media' }], pagination: { limit: 100, has_more: false, next_cursor: null } }),
    } as unknown as VideoVectorClient;
    const result = await executeTool('list_studio_scope', {}, client);
    await executeTool('list_studio_scope', { video_ids: ['v1', 'v1'] }, client);
    expect(client.workflowSearchScope).toHaveBeenCalledWith({ video_ids: ['v1'], latest_only: true, container_index_id: 'playground' });
    expect(result._meta).toMatchObject({ catalog: { videos: [{ video_id: 'v1', title: 'Clip' }] } });
    expect(JSON.stringify(result)).not.toContain('private-owner');
    expect(JSON.stringify(result)).not.toContain('private-media');
    expect(result.structuredContent).toBeUndefined();
  });

  it('preserves the video library for narrowing when the default execution scope is too large', async () => {
    const client = {
      workflowSearchScope: vi.fn().mockRejectedValue(new VideoVectorApiError('Narrow the selected videos', 'scope_too_large', 422)),
      getPlaygroundVideos: vi.fn().mockResolvedValue({ data: [{ video_id: 'v1', title: 'Clip' }], pagination: { limit: 100, has_more: false, next_cursor: null } }),
    } as unknown as VideoVectorClient;
    const first = await executeTool('list_studio_scope', {}, client);
    expect(first.isError).not.toBe(true);
    expect(first._meta).toMatchObject({ catalog: { scope_error: 'Narrow the selected videos', videos: [{ video_id: 'v1' }] } });
    const next = await executeTool('list_studio_scope', { cursor: 'next' }, client);
    expect(next.isError).not.toBe(true);
    expect(client.workflowSearchScope).toHaveBeenCalledTimes(2);
    expect(client.getPlaygroundVideos).toHaveBeenLastCalledWith({ limit: 100, cursor: 'next' });
  });

  it('keeps all library media while independently resolving completed search targets', async () => {
    const client = {
      workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [{ video_id: 'v1', run_id: 'r1' }], fields: [] }),
      getPlaygroundVideos: vi.fn().mockResolvedValueOnce({ data: [{ video_id: 'v1' }, { video_id: 'v2' }], pagination: { has_more: false, next_cursor: null } })
        .mockResolvedValueOnce({ data: [{ video_id: 'v1' }], pagination: { has_more: true, next_cursor: 'next' } }),
    } as unknown as VideoVectorClient;
    await executeTool('list_studio_scope', {}, client);
    expect(client.workflowSearchScope).toHaveBeenCalledExactlyOnceWith({ video_ids: ['v1', 'v2'], latest_only: true, container_index_id: 'playground' });
    const broad = await executeTool('list_studio_scope', {}, client);
    expect(broad._meta).toMatchObject({ catalog: { videos: [{ video_id: 'v1' }], nextCursor: 'next' } });
    expect(client.workflowSearchScope).toHaveBeenCalledTimes(2);
  });

  it('expands execution groups through the same scope resolver and rejects ambiguous selectors', async () => {
    const client = { workflowSearchScope: vi.fn().mockResolvedValue({ runs: [{ run_id: 'r1', video_ids: ['v1', 'v2'] }] }) } as unknown as VideoVectorClient;
    const result = await executeTool('list_studio_scope', { prompt_run_ids: ['r1'] }, client);
    expect(result.isError).not.toBe(true);
    expect(client.workflowSearchScope).toHaveBeenCalledWith({ prompt_run_ids: ['r1'] });
    expect(result._meta).toMatchObject({ catalog: { runs: [{ video_ids: ['v1', 'v2'] }] } });
    expect((await executeTool('list_studio_scope', { prompt_run_ids: ['r1'], video_ids: ['v1'] }, client)).isError).toBe(true);
    expect(client.workflowSearchScope).toHaveBeenCalledTimes(1);
  });

  it('keeps index library reads and selected-video scope inside the same index', async () => {
    const processing = [{ run_id: 'active', status: 'processing', total_parts: 2, completed_parts: 1, failed_parts: 0,
      activity: { phase: 'extracting' }, readiness: { metadata_available: true, assets_ready: false } }];
    const client = { getVideosInIndex: vi.fn().mockResolvedValue({ data: [{ video_id: 'done', title: 'Done' }, { video_id: 'pending', title: 'Pending', processing_status: processing }], pagination: {} }),
      getPlaygroundVideos: vi.fn(), workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [{ run_id: 'latest', video_id: 'done' }], fields: [] }),
    } as unknown as VideoVectorClient;
    const result = await executeTool('list_studio_scope', { index_id: 'index-a' }, client);
    expect(client.getVideosInIndex).toHaveBeenCalledWith('index-a', 100, undefined);
    expect(client.getPlaygroundVideos).not.toHaveBeenCalled();
    expect(client.workflowSearchScope).toHaveBeenCalledWith({ video_ids: ['done', 'pending'], latest_only: true, container_index_id: 'index-a' });
    expect(result._meta).toMatchObject({ catalog: { container: { type: 'index', index_id: 'index-a' }, videos: [{ video_id: 'done' }, { video_id: 'pending' }] } });
    expect((result._meta?.catalog as any).videos).toHaveLength(2);
    expect((result._meta?.catalog as any).videos[1].processing_status).toEqual(processing);
  });

  it('refreshes progress privately without minting grants, renewing one only on download intent', async () => {
    const client = { getAnalysis: vi.fn().mockResolvedValue({ analysis_id: 'a1', stage: 'processing', results: { revision: 'r1', included_videos: 1 } }) } as unknown as VideoVectorClient;
    const result = await executeTool('read_analysis', { analysis_id: 'a1' }, client);
    expect(client.getAnalysis).toHaveBeenCalledWith('a1', { detail: 'summary', include_download: false }, undefined, undefined);
    expect(result.structuredContent).toBeUndefined(); expect(JSON.stringify(result.content)).not.toContain('r1');
    await executeTool('read_analysis', { analysis_id: 'a1', video_id: 'v1', intent: 'download' }, client);
    expect(client.getAnalysis).toHaveBeenLastCalledWith('a1', { detail: 'summary', include_download: true, video_id: 'v1' }, undefined, undefined);
  });


  it('passes native observation through the original cancellation and deadline without metadata reads', async () => {
    const progress = { analysis_id: 'a1', run_id: 'a1', import_id: null, version: 'v2', idle: false, scope: { type: 'videos', video_ids: ['v1'] }, records: [] };
    const client = { observeAnalysis: vi.fn().mockResolvedValue(progress), getAnalysis: vi.fn() } as unknown as VideoVectorClient;
    const controller = new AbortController();
    const result = await executeTool('read_analysis', { analysis_id: 'a1', observe: true, after_version: 'v1', wait_seconds: 25 }, client, { signal: controller.signal, deadline: 123 });
    expect(client.observeAnalysis).toHaveBeenCalledExactlyOnceWith('a1', { after_version: 'v1', wait_seconds: 25 }, controller.signal, 123);
    expect(result._meta?.progress).toEqual(progress);
    expect(result.structuredContent).toBeUndefined();
    expect(client.getAnalysis).not.toHaveBeenCalled();
    for (const args of [ { analysis_id: 'a1', observe: true, detail: 'full' }, { analysis_id: 'a1', after_version: 'v1' }, { analysis_id: 'a1', observe: true, wait_seconds: 26 } ]) {
      expect((await executeTool('read_analysis', args, client)).isError).toBe(true);
    }
    expect(client.observeAnalysis).toHaveBeenCalledTimes(1);
  });
  it('submits combined search with the selected index constraint through the existing view adapter', async () => {
    const client = { workflowSearchMedia: vi.fn().mockResolvedValue({ snapshot_id: 'snap', data: [], pagination: {} }) } as unknown as VideoVectorClient;
    const result = await executeTool('view_workflow_results', { action: 'search', container_index_id: 'idx', video_ids: ['v1'], query: 'blue car', filters: [{ field: 'colour', operator: 'equals', value: 'blue' }], idempotency_key: 'retry-key' }, client);
    expect(result.isError).not.toBe(true);
    expect(client.workflowSearchMedia).toHaveBeenCalledWith({ video_ids: ['v1'], container_index_id: 'idx', latest_only: true, query: 'blue car', filters: [{ field: 'colour', operator: 'equals', value: 'blue' }], result_level: 'segment', limit: 50 }, 'retry-key');
    expect(result._meta).toHaveProperty('view'); expect(result.structuredContent).toBeUndefined();
  });

  it('keeps preview capabilities outside text and validates the bounded identity contract', async () => {
    const items = [{ kind: 'segment', video_id: 'v1', segment_id: 's1' }];
    const client = { getPreviewGrants: vi.fn().mockResolvedValue({ items: [{ ...items[0], gif_uri: 'https://storage.googleapis.com/private-signed' }] }) } as unknown as VideoVectorClient;
    const result = await executeTool('get_studio_previews', { items }, client);
    expect(client.getPreviewGrants).toHaveBeenCalledWith(items);
    expect(JSON.stringify(result.content)).not.toContain('private-signed');
    expect(result._meta).toHaveProperty('previews');
    for (const invalid of [[{ kind: 'video', video_id: 'v1', segment_id: 's1' }], Array(25).fill(items[0]), []]) {
      expect((await executeTool('get_studio_previews', { items: invalid }, client)).isError).toBe(true);
    }
    expect(client.getPreviewGrants).toHaveBeenCalledTimes(1);
  });
});
