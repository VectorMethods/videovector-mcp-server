import type { PromptRun, Video } from '../services/api';
import type { SegmentData } from '../services/segmentCache';

export const buildSegmentMetadata = (segment: SegmentData, segmentIndex: number, includeErrors = false) => ({
  segment_id: segment.segment_id,
  segment_index: segmentIndex + 1,
  start_time: segment.start_time,
  end_time: segment.end_time,
  duration: segment.end_time - segment.start_time,
  metadata: segment.metadata || {},
  metadata_text: segment.metadata_text || null,
  transcription: segment.metadata?.transcription || null,
  processing_status: {
    processed: segment.processed,
    processing_failed: segment.processing_failed,
    field_extraction_succeeded: segment.field_extraction_succeeded,
    transcription_succeeded: segment.transcription_succeeded,
    image_embedding_succeeded: segment.image_embedding_succeeded,
    ...(includeErrors ? {
      field_extraction_error: segment.field_extraction_error || null,
      transcription_error: segment.transcription_error || null,
      image_embedding_error: segment.image_embedding_error || null,
    } : {}),
  },
});

export const buildSegmentMetadataExport = ({
  segment, segmentIndex, videoId, videoTitle, runId, promptName, exportedAt = new Date().toISOString(),
}: {
  segment: SegmentData; segmentIndex: number; videoId: string; videoTitle: string;
  runId?: string | null; promptName?: string | null; exportedAt?: string;
}) => ({
  export_info: {
    exported_at: exportedAt, video_id: videoId, video_title: videoTitle,
    prompt_run_id: runId || null, prompt_name: promptName || null,
  },
  segment: buildSegmentMetadata(segment, segmentIndex, true),
});

export const buildStudioRunMetadata = ({ run, segments, videoLevelOutput, mediaType }: {
  run: Partial<PromptRun> & { run_id: string }; segments: SegmentData[];
  videoLevelOutput: unknown; mediaType?: string;
}) => ({
  run_id: run.run_id,
  prompt_id: run.prompt_id,
  prompt_name: run.prompt_name,
  prompt_type: run.prompt_type,
  executed_at: run.executed_at,
  status: run.status,
  segmentation_type: (mediaType === 'audio' ? run.audio_segmentation_type : run.video_segmentation_type) || null,
  segment_duration: (mediaType === 'audio' ? run.audio_segment_duration : run.video_segment_duration) ?? null,
  total_videos: run.total_videos,
  completed_videos: run.completed_videos,
  failed_videos: run.failed_videos,
  enable_transcription: run.enable_transcription,
  enable_image_embedding: run.enable_image_embedding,
  field_extraction_succeeded: run.field_extraction_succeeded,
  transcription_succeeded: run.transcription_succeeded,
  image_embedding_succeeded: run.image_embedding_succeeded,
  video_level_output: videoLevelOutput,
  segments: segments.map((segment, index) => buildSegmentMetadata(segment, index)),
});

export const buildStudioMetadataExport = ({
  video, promptRuns, resultScope, resultSearch, resultFilter, exportedAt = new Date().toISOString(),
}: {
  video: Pick<Video, 'video_id' | 'title'> & Partial<Pick<Video, 'status' | 'created_at'>>;
  promptRuns: ReturnType<typeof buildStudioRunMetadata>[];
  resultScope: 'all' | 'matches'; resultSearch?: string; resultFilter?: unknown; exportedAt?: string;
}) => ({
  export_info: {
    exported_at: exportedAt, video_id: video.video_id, video_title: video.title,
    total_prompt_runs: promptRuns.length, result_scope: resultScope,
    ...(resultSearch === undefined ? {} : { result_search: resultSearch, result_filter: resultFilter ?? null }),
  },
  video: { video_id: video.video_id, title: video.title, status: video.status, created_at: video.created_at },
  prompt_runs: promptRuns,
});
