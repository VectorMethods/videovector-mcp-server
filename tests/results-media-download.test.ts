import { describe, expect, it, vi } from 'vitest';
import type { VideoVectorClient } from '../src/client/index.js';
import { VideoVectorApiError } from '../src/types/index.js';
import { executeTool } from '../src/tools/index.js';

const url = 'https://storage.googleapis.com/private/media.mp4?X-Goog-Signature=private-media';
const page = { run_id: 'run', destination: { type: 'playground' }, filtered: null, unfiltered: { data: [], pagination: { has_more: false } } };
const viewArgs = { source_kind: 'prompt_run', source_id: 'run', video_id: 'video', result_level: 'video', include_context: true };
function backend(overrides = {}): VideoVectorClient {
  return {
    workflowRunResults: vi.fn().mockResolvedValue(page), workflowDelivery: vi.fn().mockResolvedValue({ artifacts: [] }),
    getPreviewGrants: vi.fn().mockResolvedValue({ items: [] }),
    getPromptRun: vi.fn().mockResolvedValue({ run_id: 'run', prompt_id: 'prompt', prompt_name: 'Engine', status: 'completed', video_level_enabled: true,
      video_segment_duration: 10, selection_filter: { segment: { conditions: [] } }, selection_summary: { status: 'ready' }, run_context: { private: url } }),
    getVideo: vi.fn().mockResolvedValue({ video_id: 'video', title: 'Video', status: 'processed', created_at: '2026-09-01T00:00:00Z', gcs_uri: 'gs://private/media.mp4', signed_url: url }),
    getPromptRunVideoResult: vi.fn().mockResolvedValue({ result_id: 'video:video:run', result_type: 'video', run_id: 'run', video_id: 'video', status: 'successful',
      metadata: { summary: 'Full persisted analysis' }, metadata_text: 'Full text', source_index_id: 'private-owner', gcs_uri: 'gs://private/media.mp4' }),
    ...overrides,
  } as unknown as VideoVectorClient;
}

describe('card media download and metadata context', () => {
  it.each([undefined, 'segment'])('privately returns the owned %s download with a trusted filename', async segmentId => {
    const filename = segmentId ? 'segment-segment.mp4' : 'video-video.mp4';
    const client = backend({ workflowMediaGrant: vi.fn().mockResolvedValue({ url, expires_at: '2030-01-01T00:00:00Z', mime_type: 'video/mp4', filename }) });
    const args = { video_id: 'video', run_id: 'run', ...(segmentId ? { segment_id: segmentId } : {}), intent: 'download' };
    const result = await executeTool('play_workflow_media', args, client, { authenticationKind: 'oauth' });
    expect(client.workflowMediaGrant).toHaveBeenCalledExactlyOnceWith(args);
    expect(result._meta?.file).toEqual({ url, name: filename, mimeType: 'video/mp4' });
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain('private-media');
  });

  it('rejects invalid intent and segment-without-run before minting', async () => {
    const client = backend({ workflowMediaGrant: vi.fn() });
    for (const args of [{ video_id: 'video', intent: 'other' }, { video_id: 'video', segment_id: 'segment', intent: 'download' }]) {
      expect((await executeTool('play_workflow_media', args, client)).isError).toBe(true);
    }
    expect(client.workflowMediaGrant).not.toHaveBeenCalled();
  });

  it('does not offer an incomplete download response from an older backend', async () => {
    const client = backend({ workflowMediaGrant: vi.fn().mockResolvedValue({ url, expires_at: '2030-01-01T00:00:00Z' }) });
    const result = await executeTool('play_workflow_media', { video_id: 'video', intent: 'download' }, client);
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private-media');
  });

  it('privately reads canonical run/media context and full video analysis once', async () => {
    const client = backend();
    const result = await executeTool('view_workflow_results', viewArgs, client, { authenticationKind: 'oauth' });
    expect(result.isError).not.toBe(true);
    expect(client.getPromptRun).toHaveBeenCalledExactlyOnceWith('run');
    expect(client.getVideo).toHaveBeenCalledExactlyOnceWith('video');
    expect(client.getPromptRunVideoResult).toHaveBeenCalledExactlyOnceWith('run', 'video');
    expect(result._meta?.context).toMatchObject({
      run: { run_id: 'run', prompt_name: 'Engine', video_segment_duration: 10, selection_summary: { status: 'ready' } },
      video: { video_id: 'video', title: 'Video', created_at: '2026-09-01T00:00:00Z' },
      video_level_output: { metadata: { summary: 'Full persisted analysis' }, metadata_text: 'Full text', },
    });
    expect(JSON.stringify(result._meta?.context)).not.toMatch(/gs:\/\/|private-owner|run_context|private-media/);
    expect(JSON.stringify(result.content)).not.toContain('Full persisted analysis');
    expect(result.structuredContent).toBeUndefined();
  });

  it('does not repeat context reads for ordinary continuation pages', async () => {
    const client = backend();
    const { include_context: _includeContext, ...args } = viewArgs;
    const result = await executeTool('view_workflow_results', args, client);
    expect(result.isError).not.toBe(true);
    expect(client.getPromptRun).not.toHaveBeenCalled();
    expect(client.getVideo).not.toHaveBeenCalled();
    expect(result._meta).not.toHaveProperty('context');
  });

  it('represents absent video analysis as null without inventing an output', async () => {
    const client = backend({ getPromptRunVideoResult: vi.fn().mockRejectedValue(new VideoVectorApiError('Not found', 'resource_not_found', 404)) });
    const result = await executeTool('view_workflow_results', viewArgs, client);
    expect(result.isError).not.toBe(true);
    expect(result._meta?.context).toHaveProperty('video_level_output', null);
  });

  it('requires exact owned run/video scope before reading context', async () => {
    const client = backend();
    for (const args of [{ ...viewArgs, video_id: undefined }, { ...viewArgs, source_kind: 'search_snapshot' }, { ...viewArgs, include_context: 'yes' }]) {
      expect((await executeTool('view_workflow_results', args, client)).isError).toBe(true);
    }
    expect(client.workflowRunResults).not.toHaveBeenCalled();
    expect(client.getPromptRun).not.toHaveBeenCalled();
  });
});
