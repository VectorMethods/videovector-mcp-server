export type SegmentProcessingStatus = 'pending' | 'processing' | 'successful' | 'failed';

export interface SegmentStatusProjection {
  segment_status?: SegmentProcessingStatus | null;
  processed?: boolean | null;
  processing_failed?: boolean | null;
}

/** Resolve legacy flags only when the backend has not supplied its canonical status. */
export const resolveSegmentProcessingStatus = (
  segment: SegmentStatusProjection,
): SegmentProcessingStatus => {
  const explicitStatus = segment.segment_status;
  if (
    explicitStatus === 'pending'
    || explicitStatus === 'processing'
    || explicitStatus === 'successful'
    || explicitStatus === 'failed'
  ) {
    return explicitStatus;
  }
  // Failure wins for ambiguous legacy records that carry both booleans.
  if (segment.processing_failed) {
    return 'failed';
  }
  if (segment.processed) {
    return 'successful';
  }
  return 'pending';
};
