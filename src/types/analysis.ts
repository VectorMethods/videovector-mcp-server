import type { WorkflowUploadGrant } from './api.js';

export interface AnalysisProgressSnapshot {
  analysis_id: string;
  import_id: string | null;
  run_id: string | null;
  version: string;
  idle: boolean;
  scope: { type: string; index_id?: string; video_ids: string[] };
  records: Array<{ kind: 'video' | 'run' | 'import_job'; id: string; version: string; state: Record<string, unknown> }>;
}

export interface AnalysisReadOptions {
  wait_seconds?: number;
  detail?: 'summary' | 'full';
  video_id?: string;
  include_download?: boolean;
  page_size?: number;
  cursor?: string;
}
export interface AnalysisResponse extends Record<string, unknown> {
  analysis_id: string;
  status: string;
  stage: string;
  message: string;
  scope: { type: 'playground' | 'index' | 'videos'; index_id?: string; video_ids?: string[] };
  progress: { total: number; imported: number; completed: number; failed: number; partial?: number; processing?: number };
  results: { revision: string; included_videos: number; final: boolean; download_url: string | null; expires_in_seconds: number | null; expires_at?: string; segment_downloads?: Array<{ video_id: string; segment_id: string; start_time: number; end_time: number; download_url: string; expires_at: string }>; preview?: unknown; data?: unknown; videos?: unknown[] };
  files?: unknown[];
  errors?: unknown[];
  next_action: { type: string; after_seconds?: number; idempotency_key?: string };
  upload?: WorkflowUploadGrant;
}
