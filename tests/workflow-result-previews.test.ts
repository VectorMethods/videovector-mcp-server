import { describe, expect, it, vi } from 'vitest';
import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool } from '../src/tools/index.js';
import { addWorkflowPreviewReferences } from '../src/tools/workflow-result-previews.js';

const row = { result_id: 'segment:s1:r1', run_id: 'r1', video_id: 'v1', segment_id: 's1', metadata: { scene: 'A scene' }, thumbnail_gcs_uri: 'gs://private/poster.webp', gif_gcs_uri: 'gs://private/animation.webp', thumbnail_uri: 'https://storage.googleapis.com/private?signature=secret' };
const page = { data: [row], pagination: { limit: 10, has_more: false, next_cursor: null } };
const runPage = { run_id: 'r1', status: 'completed', result_level: 'segment', filtered: page, unfiltered: page };

describe('private workflow preview references', () => {
  it('retains sibling segment previews on app-only run page hydration', async () => {
    const sibling = { ...row, result_id: 'segment:s2:r1', segment_id: 's2', thumbnail_gcs_uri: 'gs://private/sibling.jpg', gif_gcs_uri: 'gs://private/sibling.webp' };
    const client = { workflowRunResults: vi.fn().mockResolvedValue({ ...runPage, unfiltered: { ...page, data: [row, sibling] } }), getPreviewGrants: vi.fn() } as unknown as VideoVectorClient;
    const result = await executeTool('view_workflow_results', { source_kind: 'prompt_run', source_id: 'r1', video_id: 'v1', view: 'unfiltered' }, client);
    expect(result.isError).not.toBe(true);
    expect((result._meta?.view as any).unfiltered.data[1]).toMatchObject({ segment_id: 's2', thumbnail_gcs_uri: sibling.thumbnail_gcs_uri, gif_gcs_uri: sibling.gif_gcs_uri });
    expect(JSON.stringify([result.content, result.structuredContent])).not.toContain('gs://private');
    expect(client.getPreviewGrants).not.toHaveBeenCalled();
  });

  it('keeps parent-video and segment projection families separate', () => {
    const view = { data: [{ result_id: 'video:v1:r1', video_id: 'v1' }] };
    addWorkflowPreviewReferences(view, { data: [{ result_id: 'video:v1:r1', video_id: 'v1', thumbnail_gcs_uri: 'gs://private/segment.webp', video_thumbnail_gcs_uri: 'gs://private/video.webp', video_gif_gcs_uri: 'https://signed.example/expired' }] });
    expect(view.data[0]).toMatchObject({ thumbnail_gcs_uri: 'gs://private/segment.webp', video_thumbnail_gcs_uri: 'gs://private/video.webp', video_gif_gcs_uri: null });
  });
  it('never attaches references from a mismatched video', () => {
    const view = { data: [{ result_id: row.result_id, video_id: 'other' }] };
    addWorkflowPreviewReferences(view, { data: [row] });
    expect(view.data[0]).not.toHaveProperty('thumbnail_gcs_uri');
  });
});
