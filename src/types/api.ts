/**
 * VideoVector API Type Definitions
 *
 * These types mirror the backend Pydantic models for type-safe API interactions.
 */

// ============================================================================
// Common Types
// ============================================================================

export interface PaginationMeta {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ============================================================================
// Index Types
// ============================================================================

export interface Index {
  index_id: string;
  name: string;
  user_id: string;
  created_at: string;
  is_default: boolean;
  description?: string | null;
  sort_order?: number | null;
}

// ============================================================================
// Video Types
// ============================================================================

export type MediaType = 'video' | 'audio' | 'image';
export type ProcessingStatus = 'NOT_PROCESSED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface SegmentRunProcessingStatus {
  segment_id: string;
  video_id: string;
  status: string;
  start_time?: number | null;
  end_time?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  error_message?: string | null;
  failure_stage?: string | null;
  attempt_id?: string | null;
}

export interface VideoLevelProcessingStatus {
  status: string;
  result_available: boolean;
  successful_segment_count: number;
  failed_segment_count: number;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  error_message?: string | null;
  attempt_id?: string | null;
}

export interface PromptRunProcessingStatus {
  run_id: string;
  prompt_id?: string | null;
  status: string;
  total_segments: number;
  pending_segments: number;
  processing_segments: number;
  successful_segments: number;
  failed_segments: number;
  created_at?: string | null;
  updated_at?: string | null;
  attempt_id?: string | null;
  video_level?: VideoLevelProcessingStatus | null;
  segments: SegmentRunProcessingStatus[];
}

export interface Video {
  video_id: string;
  title: string;
  video_uri: string;
  status: string;
  processing_status?: PromptRunProcessingStatus[] | null;
  created_at: string;
  updated_at: string;
  duration_seconds?: number | null;
  metadata_keys: string[] | null;
  media_type: MediaType;
  marker: MarkerInfo;
}

export interface Segment {
  segment_id: string;
  video_id: string;
  start_time: number;
  end_time: number;
  gcs_uri: string | null;
  thumbnail_gcs_uri: string | null;
  gif_gcs_uri: string | null;
  thumbnail_uri: string | null;
  gif_uri: string | null;
  processed: boolean;
  processing_failed: boolean;
  segment_status: string;
  failure_stage: string | null;
  failure_message: string | null;
  attempt_id: string | null;
  status_source: string | null;
  metadata: Record<string, unknown> | null;
  metadata_text: string | null;
  created_at: string | null;
  processed_at: string | null;
  error_message: string | null;
  processing_warning: string | null;
  thumbnail_data: string | null;
  thumbnail_available: boolean;
  gif_data: string | null;
  gif_available: boolean;
  from_run_id: string | null;
  marker: MarkerInfo;
  metadata_markers: Record<string, MarkerInfo>;
  field_extraction_succeeded: boolean | null;
  transcription_succeeded: boolean | null;
  image_embedding_succeeded: boolean | null;
  field_extraction_error: string | null;
  transcription_error: string | null;
  image_embedding_error: string | null;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchRequest {
  query: string;
  top_k?: number;
  search_fields?: string[] | null;
  run_ids?: string[] | null;
  index_ids?: string[] | null;
}

export interface SearchResult {
  result_type: 'segment' | 'video';
  result_id: string;
  video_id: string;
  video_uri: string | null;
  segment_id: string | null;
  start_time: number | null;
  end_time: number | null;
  preview_segment_id?: string | null;
  preview_start_time?: number | null;
  preview_end_time?: number | null;
  preview_segment_uri?: string | null;
  preview_thumbnail_uri?: string | null;
  preview_gif_uri?: string | null;
  text_content: string;
  content_preview: string;
  metadata_text?: string | null;
  similarity_score: number | null;
  reranked_score?: number | null;
  segment_uri: string | null;
  gcs_uri: string | null;
  thumbnail_gcs_uri: string | null;
  gif_gcs_uri: string | null;
  thumbnail_uri: string | null;
  thumbnail_data: string | null;
  thumbnail_available: boolean;
  gif_uri: string | null;
  gif_data: string | null;
  gif_available: boolean;
  media_type?: MediaType | null;
  metadata?: Record<string, unknown> | null;
  extracted_metadata: Record<string, unknown> | null;
  field_scores: Record<string, number> | null;
  field_instance_scores?: Record<string, number> | null;
  matched_field_paths: string[] | null;
  matched_field_instances?: Array<{
    field_path: string;
    field_display_label?: string | null;
    field_instance_key: string;
    field_instance_path: string;
    field_instance_display_label?: string | null;
    score: number;
    value_preview?: string;
  }> | null;
  run_id: string | null;
  source_run_id?: string | null;
  prompt_run_id?: string | null;
  raw_llm_response?: string | null;
  source_index_id: string | null;
  marker: MarkerInfo;
  extracted_metadata_markers: Record<string, MarkerInfo>;
  // Video info (enriched by MCP handlers)
  video_name?: string | null;
}

export interface ImageSearchRequest {
  image_data: string;
  top_k?: number;
  run_ids?: string[] | null;
  index_ids?: string[] | null;
}

export interface ImageSearchResult extends SearchResult {
  matched_image_uri: string | null;
  matched_image_timestamp: number | null;
  matched_image_score: number | null;
  shot_timestamp: number | null;
}

export interface MultimodalSearchRequest {
  text_query?: string | null;
  image_data?: string | null;
  top_k?: number;
  text_weight?: number;
  image_weight?: number;
  search_fields?: string[] | null;
  run_ids?: string[] | null;
  index_ids?: string[] | null;
}

export type MatchType = 'both' | 'text_only' | 'image_only';

export interface MultimodalSearchResult extends SearchResult {
  fused_score: number;
  text_score: number | null;
  image_score: number | null;
  text_rank: number | null;
  image_rank: number | null;
  match_type: MatchType;
  matched_image_uri: string | null;
  matched_image_timestamp: number | null;
  matched_image_score?: number | null;
  shot_timestamp?: number | null;
}

// ============================================================================
// Filter Search Types
// ============================================================================

// Backend canonical operators exposed by the public MCP filter_videos contract.
export type FilterOperator =
  | 'equals'
  | 'greater_than'
  | 'greater_equal'
  | 'less_than'
  | 'less_equal'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'item_equals'
  | 'item_contains'
  | 'length_equals'
  | 'length_greater'
  | 'length_less';
export type FilterValueType = 'string' | 'integer' | 'number' | 'boolean' | 'array';

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: unknown;
  type: FilterValueType;
}

export interface FilterSearchRequest {
  conditions: FilterCondition[];
  page_size?: number;
  cursor?: string | null;
  run_ids: string[];
  index_ids?: string[] | null;
}

export interface FilterSearchResponse {
  results: SearchResult[];
  next_page_token: string | null;
  total_shown: number;
}

// ============================================================================
// Prompt Types
// ============================================================================

export interface Prompt {
  prompt_id: string;
  user_id: string;
  name: string;
  description: string;
  prompt_text: string;
  json_schema: Record<string, unknown>;
  video_level: PromptVideoLevelConfig | null;
  semantic_indexing: PromptSemanticIndexingConfig;
  is_active: boolean;
  created_at: string;
}

export interface PromptListResponse {
  prompts: Prompt[];
  total_count: number;
  active_count: number;
}

export interface TestSchemaResponse {
  valid: boolean;
  validated_data: Record<string, unknown> | null;
  error: string | null;
  message: string;
}

export interface PromptUsageStats {
  prompt_id: string;
  name: string;
  is_active: boolean;
  is_in_use: boolean;
  created_at: string;
  schema_properties_count: number;
}

export interface MarkerInfo {
  marker_id: string | null;
  color: string | null;
  note: string | null;
  updated_at: string | null;
}

export interface PromptVideoLevelConfig {
  instructions_text: string;
  included_segment_fields: string[];
  json_schema: Record<string, unknown>;
}

export interface PromptSemanticIndexingConfig {
  disabled_segment_fields: string[];
  disabled_video_level_fields: string[];
}

// ============================================================================
// Prompt Run Types
// ============================================================================

export type PromptRunStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'completed_with_failures'
  | 'failed'
  | 'cancelled';
export type VideoSegmentationType = 'smart' | 'fixed' | 'content_aware';
export type AudioSegmentationType = 'fixed' | 'content_aware';

export interface ExecutePromptTarget {
  type: 'index' | 'videos' | 'playground';
  index_id?: string;
  video_ids?: string[];
}

export interface ExecutePromptRequest {
  prompt_id: string;
  target: ExecutePromptTarget;
  video_segmentation_type?: VideoSegmentationType;
  audio_segmentation_type?: AudioSegmentationType;
  video_segment_duration?: number | null;
  audio_segment_duration?: number | null;
  processing_model?: string | null;
  enable_transcription?: boolean;
  enable_image_embedding?: boolean;
}

export interface PromptRunCostEstimate {
  estimated_mt: number;
  breakdown: Record<string, unknown>;
  sufficient_balance: boolean;
  current_balance_mt: number;
}

export interface PromptRun {
  run_id: string;
  prompt_id: string;
  prompt_name: string;
  prompt_type: string;
  executed_at: string;
  executed_by: string;
  status: PromptRunStatus;
  run_context: Record<string, unknown>;
  completed_videos: number;
  failed_videos: number;
  partial_videos: number;
  cancelled_videos: number;
  total_videos: number;
  error_message: string | null;
  video_segmentation_type: string;
  audio_segmentation_type: string;
  image_segmentation_type: string;
  video_segment_duration: number | null;
  audio_segment_duration: number | null;
  created_new_segments: boolean;
  processing_model: string | null;
  total_video_seconds: number;
  enable_transcription: boolean;
  enable_image_embedding: boolean;
  total_audios: number;
  total_images: number;
  completed_audios: number;
  completed_images: number;
  failed_audios: number;
  failed_images: number;
  partial_audios: number;
  partial_images: number;
  cancelled_audios: number;
  cancelled_images: number;
  total_segments: number;
  completed_segments: number;
  field_extraction_failures: number;
  transcription_failures: number;
  image_embedding_failures: number;
  field_extraction_succeeded: boolean | null;
  transcription_succeeded: boolean | null;
  image_embedding_succeeded: boolean | null;
  video_level_enabled: boolean;
  video_level_total_items: number;
  video_level_completed_items: number;
  video_level_failed_items: number;
  video_level_partial_items: number;
  billing_estimated_mt: number;
  billing_actual_mt: number;
  billing_status: string | null;
  billing_error: string | null;
  stop_state?: PromptRunStopState | null;
  marker: MarkerInfo;
}

export interface PromptRunStopState {
  requested_at?: string | null;
  requested_by?: string | null;
  mode?: string | null;
  observed_at?: string | null;
  completed_at?: string | null;
}

export interface SegmentRunResult {
  result_type: 'segment';
  result_id: string;
  segment_id: string;
  video_id?: string | null;
  run_id: string;
  prompt_id: string;
  prompt_run_id: string;
  video_name?: string | null;
  source_index_id?: string | null;
  executed_at: string;
  start_time?: number | null;
  end_time?: number | null;
  segment_uri?: string | null;
  gcs_uri?: string | null;
  thumbnail_gcs_uri?: string | null;
  gif_gcs_uri?: string | null;
  thumbnail_uri?: string | null;
  gif_uri?: string | null;
  thumbnail_available?: boolean;
  gif_available?: boolean;
  metadata: Record<string, unknown>;
  metadata_text: string;
  processing_warning: string | null;
  schema_used: string | null;
  field_extraction_succeeded: boolean;
  transcription_succeeded: boolean | null;
  image_embedding_succeeded: boolean | null;
  field_extraction_error: string | null;
  transcription_error: string | null;
  image_embedding_error: string | null;
  marker?: MarkerInfo | null;
  extracted_metadata_markers?: Record<string, MarkerInfo> | null;
  metadata_markers: Record<string, MarkerInfo>;
}

export interface PromptRunVideoResult {
  result_type: 'video';
  result_id: string;
  run_id: string;
  prompt_id: string;
  prompt_run_id: string;
  video_id: string;
  video_name?: string | null;
  source_index_id?: string | null;
  executed_at: string;
  status: string;
  metadata: Record<string, unknown>;
  metadata_text: string;
  raw_llm_response: string | null;
  processing_warning: string | null;
  schema_used: string | null;
  successful_segment_count: number;
  failed_segment_count: number;
  omitted_segment_ids: string[];
  template_fields: string[];
  source_fingerprint: string | null;
  rendered_prompt_char_count: number;
  llm_attempted: boolean;
  attempt_id: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  segment_uri?: string | null;
  gcs_uri?: string | null;
  thumbnail_gcs_uri?: string | null;
  gif_gcs_uri?: string | null;
  thumbnail_uri?: string | null;
  gif_uri?: string | null;
  thumbnail_available?: boolean;
  gif_available?: boolean;
  preview_segment_id?: string | null;
  preview_start_time?: number | null;
  preview_end_time?: number | null;
  preview_segment_uri?: string | null;
  preview_thumbnail_uri?: string | null;
  preview_gif_uri?: string | null;
  marker?: MarkerInfo | null;
}

export interface PromptRunFailureOperationCounts {
  field_extraction: number;
  transcription: number;
  image_embedding: number;
  processing: number;
}

export interface PromptRunFailedSegment {
  segment_id: string;
  failed_operations: string[];
  field_extraction_error: string | null;
  transcription_error: string | null;
  image_embedding_error: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  failure_code: string | null;
  retryable: boolean | null;
  start_time: number | null;
  end_time: number | null;
  projection_only: boolean;
}

export interface PromptRunFailedVideo {
  video_id: string;
  failed_segments: number;
  operation_counts: PromptRunFailureOperationCounts;
  segments: PromptRunFailedSegment[];
}

export interface PromptRunFailedSegmentsManifest {
  run_id: string;
  status: string;
  videos_with_failures: number;
  failed_segments: number;
  operation_counts: PromptRunFailureOperationCounts;
  videos: PromptRunFailedVideo[];
}

export interface PromptRunSegmentRetry {
  run_id: string;
  retry_id: string;
  status: string;
  message: string;
  idempotency_key: string | null;
  video_id: string;
  segment_id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  billing_estimated_mt: number;
  billing_actual_mt: number;
  billing_status: string | null;
  billing_error: string | null;
}

export interface PromptRunSegmentRetryStatus {
  run_id: string;
  retry_id: string;
  status: string;
  video_id: string;
  segment_id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  billing_estimated_mt: number;
  billing_actual_mt: number;
  billing_status: string | null;
  billing_error: string | null;
  field_extraction_succeeded: boolean | null;
  transcription_succeeded: boolean | null;
  image_embedding_succeeded: boolean | null;
}

// ============================================================================
// Error Types
// ============================================================================

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
    timestamp?: string;
  };
}

// ============================================================================
// Prompt Management Types
// ============================================================================

export interface CreatePromptRequest {
  name: string;
  description?: string;
  prompt_text: string;
  json_schema: Record<string, unknown>;
  video_level?: PromptVideoLevelConfig | null;
  semantic_indexing?: PromptSemanticIndexingConfig | null;
}

export interface UpdatePromptRequest {
  name?: string;
  description?: string;
  prompt_text?: string;
  json_schema?: Record<string, unknown>;
  video_level?: PromptVideoLevelConfig | null;
  semantic_indexing?: PromptSemanticIndexingConfig | null;
  clear_video_level?: boolean;
}

// ============================================================================
// Cloud Connector Types
// ============================================================================

export type ConnectorProvider = 'gcs' | 's3' | 'azure';
export type ConnectorStatus = 'active' | 'testing' | 'failed' | 'disabled';
export type ConnectorScope = 'import' | 'export';
export type ConnectorImportMode = 'all' | 'new_only';

export interface CreateGCSConnectorRequest {
  name: string;
  bucket: string;
  gcp_project_id: string;
  credentials_json: Record<string, unknown>;
  scopes?: ConnectorScope[] | null;
  export_base_path?: string | null;
  import_mode?: ConnectorImportMode | null;
}

export interface CreateS3ConnectorRequest {
  name: string;
  bucket: string;
  region: string;
  aws_access_key_id: string;
  aws_secret_access_key: string;
  scopes?: ConnectorScope[] | null;
  export_base_path?: string | null;
  import_mode?: ConnectorImportMode | null;
}

export interface CreateAzureConnectorRequest {
  name: string;
  storage_account: string;
  container: string;
  tenant_id: string;
  client_id: string;
  client_secret: string;
  scopes?: ConnectorScope[] | null;
  export_base_path?: string | null;
  import_mode?: ConnectorImportMode | null;
}

export interface Connector {
  connector_id: string;
  name: string;
  provider: ConnectorProvider;
  status: ConnectorStatus;
  scopes: ConnectorScope[];
  import_mode: string;
  export_base_path: string | null;
  bucket: string | null;
  region: string | null;
  storage_account: string | null;
  container: string | null;
  gcp_project_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_tested_at: string | null;
  last_test_result: string | null;
  last_test_error: string | null;
}

export interface TestConnectionResponse {
  success: boolean;
  error_message: string | null;
}

export interface BrowseFilesRequest {
  prefix?: string;
  pattern?: string;
  recursive?: boolean;
}

export interface CloudFile {
  path: string;
  name: string;
  size_bytes: number;
  last_modified: string;
  content_type: string | null;
  extension: string;
}

// ============================================================================
// Import Job Types
// ============================================================================

export type ImportJobStatus = 'pending' | 'scanning' | 'importing' | 'completed' | 'failed' | 'cancelled';

export interface CreateImportJobRequest {
  connector_id: string;
  index_id: string;
  source_prefix?: string;
  file_pattern?: string;
  recursive?: boolean;
}

export interface ImportJobProgress {
  total_files: number;
  imported: number;
  failed: number;
  skipped: number;
  bytes_transferred: number;
  current_file: string | null;
}

export interface ImportFileError {
  path: string;
  error: string;
}

export interface ImportFileSkip {
  path: string;
  reason: string;
}

export interface ImportJob {
  job_id: string;
  connector_id: string;
  target_index_id: string;
  source_prefix: string;
  file_pattern: string;
  recursive: boolean;
  status: ImportJobStatus;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  progress: ImportJobProgress;
  video_ids: string[];
  failed_files: ImportFileError[];
  skipped_files: ImportFileSkip[];
}

// ============================================================================
// Index Management Types
// ============================================================================

export interface CreateIndexRequest {
  name: string;
}

// ============================================================================
// Video Status Types
// ============================================================================

export interface VideoStatus {
  video_id: string;
  status: string;
  processing_status?: PromptRunProcessingStatus[] | null;
}

// ============================================================================
// Export Types
// ============================================================================

export type ExportStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ExportType = 'index' | 'prompt_run';

export interface ExportDestinationRequest {
  destination_connector_id?: string | null;
  destination_subpath?: string | null;
}

export interface IndexExportRequest extends ExportDestinationRequest {
  prompt_run_ids?: string[] | null;
}

export interface ExportJob {
  export_id: string;
  export_type: ExportType;
  target_id: string;
  created_at: string | null;
  status: ExportStatus;
  download_url: string | null;
  file_size_bytes: number | null;
  error_message: string | null;
  export_params?: Record<string, unknown>;
}

// ============================================================================
// Webhook Types
// ============================================================================

export type WebhookStatus = 'active' | 'paused' | 'disabled';
export type WebhookDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'retrying';

export interface CreateWebhookRequest {
  name: string;
  url: string;
  events: string[];
  index_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateWebhookRequest {
  name?: string;
  url?: string;
  events?: string[];
  index_ids?: string[];
  status?: 'active' | 'paused';
  metadata?: Record<string, unknown>;
}

export interface Webhook {
  webhook_id: string;
  name: string;
  url: string;
  events: string[];
  index_ids: string[] | null;
  status: WebhookStatus;
  failure_count: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export interface WebhookDelivery {
  delivery_id: string;
  webhook_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  response_status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  created_at: string | null;
  completed_at: string | null;
  payload: Record<string, unknown> | null;
}

export interface TestWebhookResponse {
  success: boolean;
  status_code: number | null;
  error: string | null;
}

// ============================================================================
// Error Types
// ============================================================================

export class VideoVectorApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly requestId?: string;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>,
    requestId?: string
  ) {
    super(message);
    this.name = 'VideoVectorApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.requestId = requestId;
  }

  public isRetryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }

  public isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  public isNotFound(): boolean {
    return this.statusCode === 404;
  }

  public isValidationError(): boolean {
    return this.statusCode === 400 || this.statusCode === 422;
  }
}
