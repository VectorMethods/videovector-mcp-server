import React from 'react';
import type { Video } from '../services/api';
import './VideoSegmentStatusBars.css';

export interface VideoSegmentStatusRow { runId: string; segmentStatuses: string[] }

/** The same run ordering and status projection for library tiles and Studio rails. */
export const getVideoSegmentStatusRows = (
  processingStatus: Video['processing_status'], runScopeId?: string | null,
): VideoSegmentStatusRow[] => {
  if (!Array.isArray(processingStatus)) return [];
  const timestamp = (value?: string | null): number => {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...processingStatus]
    .sort((a, b) => timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at))
    .filter(run => !runScopeId || run.run_id === runScopeId)
    .map(run => ({ runId: run.run_id, segmentStatuses: Array.isArray(run.segments)
      ? run.segments.map(segment => segment.status || 'pending') : [] }))
    .filter(run => run.segmentStatuses.length > 0);
};

const VideoSegmentStatusBars: React.FC<{ rows: VideoSegmentStatusRow[] }> = ({ rows }) => rows.length ? (
  <div className="segment-run-stack" aria-label="Prompt run segment statuses">
    {rows.map(row => <div key={row.runId} className="segment-run-row"
      style={{ gridTemplateColumns: `repeat(${Math.max(row.segmentStatuses.length, 1)}, minmax(0, 1fr))` }}
      title={`Run ${row.runId}`}>
      {row.segmentStatuses.map((status, index) => <span key={`${row.runId}-${index}`}
        className={`segment-status-cell ${status === 'failed' ? 'failed' : status === 'successful' ? 'successful' : 'pending'}`} />)}
    </div>)}
  </div>
) : null;

export default VideoSegmentStatusBars;
