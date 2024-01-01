import { describe, expect, it, vi } from 'vitest';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';
import { VideoVectorApiError } from '../src/types/index.js';
import type { VideoVectorClient } from '../src/client/index.js';

describe('Studio consumer tools', () => {
  it('exposes private read adapters in both profiles', () => {
    for (const profile of ['simple', 'full'] as const) {
      const definitions = getToolDefinitions(profile, false, { includeAppTools: true });
      for (const name of ['list_studio_scope', 'get_studio_previews']) {
        expect(definitions.find(tool => tool.name === name)?._meta).toMatchObject({ ui: { visibility: ['app'] } });
        expect(getToolRequiredScope(name)).toBe('read');
      }
    }
    expect(getToolRequiredScope('search_media')).toBe('search');
  });

  it('loads exact video scope through canonical services and keeps the catalog private', async () => {
    const client = {
      workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [], fields: [], coverage: {}, warnings: [] }),
      getPlaygroundVideos: vi.fn().mockResolvedValue({ data: [{ video_id: 'v1', title: 'Clip', user_id: 'private-owner', video_uri: 'https://private-media' }], pagination: { limit: 100, has_more: false, next_cursor: null } }),
    } as unknown as VideoVectorClient;
    const result = await executeTool('list_studio_scope', {}, client);
    await executeTool('list_studio_scope', { video_ids: ['v1', 'v1'] }, client);
    expect(client.workflowSearchScope).toHaveBeenCalledWith({ video_ids: ['v1'] });
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
    expect(client.workflowSearchScope).toHaveBeenCalledTimes(1);
    expect(client.getPlaygroundVideos).toHaveBeenLastCalledWith({ limit: 100, cursor: 'next' });
  });

  it('resolves all Playground videos by exact video IDs and requires narrowing a larger library', async () => {
    const client = {
      workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [], fields: [] }),
      getPlaygroundVideos: vi.fn().mockResolvedValueOnce({ data: [{ video_id: 'v1' }, { video_id: 'v2' }], pagination: { has_more: false, next_cursor: null } })
        .mockResolvedValueOnce({ data: [{ video_id: 'v1' }], pagination: { has_more: true, next_cursor: 'next' } }),
    } as unknown as VideoVectorClient;
    await executeTool('list_studio_scope', {}, client);
    expect(client.workflowSearchScope).toHaveBeenCalledExactlyOnceWith({ video_ids: ['v1', 'v2'] });
    const broad = await executeTool('list_studio_scope', {}, client);
    expect(broad._meta).toMatchObject({ catalog: { scope_error: expect.stringContaining('100 selected videos'), videos: [{ video_id: 'v1' }] } });
    expect(client.workflowSearchScope).toHaveBeenCalledTimes(1);
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
