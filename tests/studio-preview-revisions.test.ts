import { describe, expect, it } from 'vitest';
import { getSearchSegmentPreviewProjection } from '../ui/utils/searchResultIdentity';
import { getPreviewGrantProjectionKey, previewGrantMatchesProjection } from '../ui/contexts/PreviewGrantContext';

describe('native asset revisions use the existing viewport preview owner', () => {
  const row = { video_id: 'v1', segment_id: 's1', result_type: 'segment' };
  const grant = { kind: 'segment', video_id: 'v1', segment_id: 's1',
    thumbnail_gcs_uri: 'gs://private/poster', gif_gcs_uri: null,
    thumbnail_uri: 'https://storage.googleapis.com/private/poster', gif_uri: null,
    grant_expires_at: '2027-01-01T00:00:00Z' };
  it('starts with no preview and resolves identity-qualified grants only after an asset revision', () => {
    expect(getSearchSegmentPreviewProjection(row as never)).toBeNull();
    const first = getSearchSegmentPreviewProjection({ ...row, assets_revision: 'poster-1' } as never)!;
    expect(first).toEqual({ identity: { kind: 'segment', video_id: 'v1', segment_id: 's1' },
      thumbnailGcsUri: null, gifGcsUri: null, assetsRevision: 'poster-1' });
    expect(previewGrantMatchesProjection(grant as never, first)).toBe(true);
    expect(previewGrantMatchesProjection({ ...grant, segment_id: 'sibling' } as never, first)).toBe(false);
    const later = getSearchSegmentPreviewProjection({ ...row, assets_revision: 'animation-2' } as never)!;
    expect(getPreviewGrantProjectionKey(first)).not.toBe(getPreviewGrantProjectionKey(later));
    expect(getPreviewGrantProjectionKey(first)).toBe(getPreviewGrantProjectionKey({ ...first }));
  });
  it('retains exact durable-URI matching for ordinary search preview projections', () => {
    const projection = getSearchSegmentPreviewProjection({ ...row, thumbnail_gcs_uri: 'gs://private/poster' } as never)!;
    expect(previewGrantMatchesProjection(grant as never, projection)).toBe(true);
    expect(previewGrantMatchesProjection({ ...grant, thumbnail_gcs_uri: 'gs://private/new-generation' } as never, projection)).toBe(false);
  });
});
