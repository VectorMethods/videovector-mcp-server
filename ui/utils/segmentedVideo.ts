import {
  getSegmentPlaybackSource,
  isRenderableMediaUri,
  pickDurableMediaUri,
} from './mediaSources';

// Segmented Video Utilities
// Core functions for managing virtual single video over multiple segments

export interface VideoSegment {
  id: string;
  videoId?: string;
  mediaScope?: 'segment' | 'video';
  playbackUrl: string;      // signed URL for playback
  previewThumbnailUrl?: string; // page-granted static poster
  previewGifUrl: string;    // page-granted animated WebP preview
  previewThumbnailGcsUri?: string; // durable poster identity for preview grants
  previewGifGcsUri?: string; // durable animation identity for preview grants
  duration: number;         // duration in seconds
  start: number;            // global start time in seconds
  end: number;              // global end time in seconds (exclusive)
  originalUri?: string;     // original GCS URI for fetching signed URL
}

/** Stable media authority for one logical segment across refreshed grants. */
export function getVideoSegmentPlaybackKey(segment: VideoSegment): string {
  return JSON.stringify([
    segment.videoId || '',
    segment.mediaScope || 'segment',
    segment.id,
    segment.originalUri || segment.playbackUrl || '',
  ]);
}

/**
 * Metadata and preview updates must not rebuild the active playback graph.
 * Only timing or media-authority changes require a player update.
 */
export function arePlaybackSegmentsEquivalent(
  left: VideoSegment[],
  right: VideoSegment[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && getVideoSegmentPlaybackKey(segment) === getVideoSegmentPlaybackKey(candidate)
      && segment.start === candidate.start
      && segment.end === candidate.end
      && segment.duration === candidate.duration;
  });
}

/**
 * Locate which segment contains a global time and calculate the local time within that segment
 * @param globalTime - Time in the global timeline (seconds)
 * @param segments - Array of segments sorted by start time
 * @returns The segment and local time within that segment
 */
export function locateGlobalTime(
  globalTime: number,
  segments: VideoSegment[]
): { segment: VideoSegment; localTime: number } {
  if (segments.length === 0) {
    throw new Error('No segments available');
  }

  // Clamp global time to valid range
  const totalDuration = segments[segments.length - 1].end;
  const clamped = Math.max(0, Math.min(globalTime, totalDuration));

  // Segment ranges are half-open. At an exact boundary, the following
  // segment owns the time. If a source contains an intentional uncovered
  // interval, retain the preceding annotation until the next one starts.
  const containingSegment = segments.find(s => clamped >= s.start && clamped < s.end);
  const precedingSegment = [...segments]
    .reverse()
    .find(s => clamped >= s.start);
  const segment = containingSegment
    ?? precedingSegment
    ?? segments[0];

  // Calculate local time within the segment
  const localTime = Math.max(0, Math.min(clamped - segment.start, segment.duration));

  return { segment, localTime };
}

/**
 * Convert a local time within a segment to a global time
 * @param segment - The segment
 * @param localTime - Time within the segment (seconds)
 * @returns Global time in seconds
 */
export function globalFromLocal(segment: VideoSegment, localTime: number): number {
  return segment.start + Math.max(0, Math.min(localTime, segment.duration));
}

/**
 * Calculate total duration from segments
 * @param segments - Array of segments
 * @returns Total duration in seconds
 */
export function getTotalDuration(segments: VideoSegment[]): number {
  if (segments.length === 0) return 0;
  return segments[segments.length - 1].end;
}

/**
 * Convert segment data from API format to VideoSegment format
 * @param segments - Raw segment data from API
 * @returns Array of VideoSegment objects sorted by start time
 */
export function prepareSegments(segments: any[], videoId?: string | null): VideoSegment[] {
  if (!segments || segments.length === 0) return [];

  // Sort segments by start time to ensure correct ordering
  const sorted = [...segments].sort((a, b) => a.start_time - b.start_time);

  // Extraction timestamps are offsets into the original media. Preserve
  // those offsets so the player, both timelines, deep links, and selected
  // metadata all share one clock even when a segmentation contains a gap.
  const videoSegments: VideoSegment[] = sorted.map(segment => {
    const start = Number(segment.start_time);
    const end = Number(segment.end_time);
    const duration = end - start;
    const immediatePlaybackSource = getSegmentPlaybackSource(segment);
    const rawPreviewSource = typeof segment.gif_uri === 'string'
      ? segment.gif_uri.trim()
      : '';
    const immediatePreviewSource = /^(?:https?:\/\/|\/)/i.test(rawPreviewSource)
      ? rawPreviewSource
      : null;
    const rawThumbnailSource = typeof segment.thumbnail_uri === 'string'
      ? segment.thumbnail_uri.trim()
      : '';
    const immediateThumbnailSource = /^(?:https?:\/\/|\/)/i.test(rawThumbnailSource)
      ? rawThumbnailSource
      : null;
    const durablePlaybackSource = pickDurableMediaUri(
      segment.gcs_uri,
      immediatePlaybackSource,
    );
    const videoSegment: VideoSegment = {
      id: segment.segment_id,
      videoId: videoId || segment.video_id || undefined,
      // A bounded first-party URL may be used immediately, but it must never
      // become the authority for future refreshes. The durable source below is
      // retained so an expired/exhausted grant can be replaced.
      playbackUrl: isRenderableMediaUri(immediatePlaybackSource)
        ? immediatePlaybackSource!
        : '',
      previewThumbnailUrl: immediateThumbnailSource || '',
      previewGifUrl: immediatePreviewSource || '',
      previewThumbnailGcsUri: pickDurableMediaUri(segment.thumbnail_gcs_uri) || undefined,
      previewGifGcsUri: pickDurableMediaUri(segment.gif_gcs_uri) || undefined,
      duration,
      start,
      end,
      originalUri: durablePlaybackSource || immediatePlaybackSource || undefined,
    };
    return videoSegment;
  });

  return videoSegments;
}

/**
 * Find segment at a specific percentage of the timeline
 * @param percent - Percentage (0-1) of the timeline
 * @param segments - Array of segments
 * @returns The segment at that position and its local time
 */
export function findSegmentAtPercent(
  percent: number,
  segments: VideoSegment[]
): { segment: VideoSegment; localTime: number } | null {
  if (segments.length === 0) return null;

  const totalDuration = getTotalDuration(segments);
  const globalTime = percent * totalDuration;

  return locateGlobalTime(globalTime, segments);
}

/**
 * Calculate the percentage position of a global time
 * @param globalTime - Time in seconds
 * @param totalDuration - Total duration in seconds
 * @returns Percentage (0-1)
 */
export function getTimelinePercent(globalTime: number, totalDuration: number): number {
  if (totalDuration === 0) return 0;
  return Math.max(0, Math.min(1, globalTime / totalDuration));
}
