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
// Simplified Workflow Types
// ============================================================================

export type WorkflowResultLevel = 'segment' | 'video';

export interface WorkflowAttachment {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface WorkflowAttachmentRequest {
  files?: WorkflowAttachment[];
  title?: string;
  index_id?: string;
  index_name?: string;
}

export interface WorkflowFindRequest {
  instruction: string;
  files?: WorkflowAttachment[];
  artifact_delivery?: 'automatic' | 'none';
}

export interface WorkflowUploadGrant {
  url: string;
  complete_url: string;
  token: string;
  expires_at: string;
  max_files: number;
  accept: string;
}

export interface AttachmentUploadDescriptor {
  file_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  last_modified: number;
  sample_sha256: string;
  restart_expired?: boolean;
}

export interface AttachmentUploadSession {
  job: WorkflowIntakeResponse;
  upload: { transport: 'resumable'; url: string; offset: number; total_bytes: number; chunk_size: number; expires_at: string } | null;
}

export interface ImportJobOutput {
  file_id: string;
  file_name: string;
  source_ordinal: number;
  part_index: number;
  part_count: number;
  source_start_seconds: number;
  source_end_seconds: number;
  video_id: string | null;
  title: string;
  status: string;
}
export interface ImportJobOutputsPage {
  items: ImportJobOutput[];
  next_cursor: string | null;
  total: number;
}
export interface ImportJobFile {
  file_id: string;
  file_name: string;
  source_ordinal: number;
  status: string;
  part_count: number | null;
  parts_completed: number | null;
  parts_failed: number | null;
  failure?: { error: string; error_code: string; http_status?: number | null; refresh_required: boolean } | null;
  skip_reason?: string | null;
}
export interface ImportJobFilesPage {
  items: ImportJobFile[];
  next_cursor: string | null;
  total: number;
}
export interface ImportJobExecution {
  status: 'not_requested' | 'pending' | 'submitted' | 'blocked';
  run_id?: string | null;
  error_code?: string | null;
  error?: string | null;
}

export interface WorkflowIntakeResponse {
  job_id: string;
  status: string;
  video_ids: string[];
  run_id?: string | null;
  source_kind?: string;
  target_index_id?: string | null;
  phase: string;
  outputs: ImportJobOutputsPage;
  execution: ImportJobExecution;
  progress?: ImportJobProgress;
  error_message?: string | null;
  upload?: WorkflowUploadGrant | null;
  failed_files_next_cursor?: string | null;
  failed_files?: Array<{
    file_id: string;
    file_name: string;
    error_code: string;
    error: string;
    http_status?: number | null;
    refresh_required: boolean;
  }>;
}

export interface WorkflowUploadRequest {
  file_path: string;
  title?: string;
  index_id?: string;
  index_name?: string;
}

export type WorkflowUploadResponse = WorkflowIntakeResponse;

export interface WorkflowDefineRequest {
  instruction: string;
  save?: boolean;
}

export interface WorkflowDefineResponse {
  prompt_id?: string | null;
  prompt?: Prompt | Record<string, unknown> | null;
  draft?: Record<string, unknown> | null;
  definition?: Record<string, unknown>;
  saved?: boolean;
  [key: string]: unknown;
}

export interface WorkflowProcessRequest extends Partial<PromptExecutionConfig> {
  import_job_id?: string;
  artifact_delivery?: 'automatic' | 'none';
  prompt_id?: string;
  prompt_instruction?: string;
  video_ids?: string[];
  index_id?: string;
  index_name?: string;
}



export interface WorkflowProcessResponse {
  run_id: string;
  run: PromptRun;
  prompt: Prompt;
  prompt_created_inline: boolean;
  status_url: string;
  results_url: string;
  [key: string]: unknown;
}

export interface WorkflowFilterCondition {
  field: string;
  operator?: FilterOperator;
  value?: unknown;
}




export interface WorkflowSearchPagination {
  limit: number;
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  result_window: number;
  truncated: boolean;
}

export interface WorkflowSearchResponse {
  snapshot_id?: string;
  expires_at?: string;
  data: Array<Record<string, unknown>>;
  mode: 'vector' | 'condition';
  result_level: WorkflowResultLevel;
  pagination: WorkflowSearchPagination;
  scope?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  warnings?: Array<Record<string, unknown> | string>;
  [key: string]: unknown;
}

export interface WorkflowDeliveryResponse {
  source_kind: 'prompt_run' | 'search_snapshot';
  source_id: string;
  artifacts: Array<Record<string, unknown>>;
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
  total_parts?: number;
  completed_parts?: number;
  failed_parts?: number;
  activity?: { phase?: string; started_at?: string; updated_at?: string };
  readiness?: Record<string, boolean>;
  result_revisions?: Record<string, string | number>;
  enrichment?: { image?: { status: 'pending' | 'processing' | 'completed' | 'failed' | 'disabled'; completed: number; total: number; failed: number } };
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
  image_embedding_status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_applicable' | null;
  field_extraction_error: string | null;
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
  matched_image_gcs_uri?: string | null;
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
  matched_image_gcs_uri?: string | null;
  matched_image_timestamp: number | null;
  matched_image_score?: number | null;
  shot_timestamp?: number | null;
}

// ============================================================================
// Filter Search Types
// ============================================================================

// Backend canonical operators exposed by metadata filters in the MCP search contract.
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
  item_type?: string | null;
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
  execution_config?: PromptExecutionConfig;
  selection_filter?: PromptSelectionFilter | null;
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
  json_schema: Record<string, unknown>;
}

export interface PromptSemanticIndexingConfig {
  disabled_segment_fields: string[];
  disabled_video_level_fields: string[];
}

export interface PromptSelectionFilter {
  segment?: { logic: 'and' | 'or'; conditions: FilterCondition[] } | null;
  video?: { logic: 'and' | 'or'; conditions: FilterCondition[] } | null;
  level_logic: 'and' | 'or';
}

export interface PromptExecutionConfig {
  video_segmentation_type: VideoSegmentationType;
  audio_segmentation_type: AudioSegmentationType;
  video_segment_duration: number | null;
  audio_segment_duration: number | null;
  processing_model: string | null;
  enable_image_embedding: boolean;
}

export interface PromptRunSelectionSummary {
  status: 'not_applicable' | 'pending' | 'ready' | 'failed';
  selected_media_count: number;
  selected_video_count: number;
  selected_segment_count: number;
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
export type VideoSegmentationType = 'fixed' | 'content_aware';
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
  field_extraction_succeeded: boolean | null;
  video_level_enabled: boolean;
  video_level_total_items: number;
  video_level_completed_items: number;
  video_level_failed_items: number;
  video_level_partial_items: number;
  billing_estimated_mt: number;
  billing_actual_mt: number;
  billing_status: string | null;
  billing_error: string | null;
  selection_summary?: PromptRunSelectionSummary;
  selection_filter?: PromptSelectionFilter | null;
  reuse_summary?: { target_media_count: number; reused_media_count: number; fresh_media_count: number };
  marker: MarkerInfo;
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
  playback_source_uri?: string | null;
  playback_start_time?: number | null;
  playback_end_time?: number | null;
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
  image_embedding_status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_applicable' | null;
  field_extraction_error: string | null;
  image_embedding_error: string | null;
  marker?: MarkerInfo | null;
  extracted_metadata_markers?: Record<string, MarkerInfo> | null;
  metadata_markers: Record<string, MarkerInfo>;
}


export interface PromptRunFailureOperationCounts {
  field_extraction: number;
  image_embedding: number;
  processing: number;
}

export interface PromptRunFailedSegment {
  segment_id: string;
  failed_operations: string[];
  field_extraction_error: string | null;
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
  execution_config?: Partial<PromptExecutionConfig>;
  selection_filter?: PromptSelectionFilter | null;
}

export interface UpdatePromptRequest {
  name?: string;
  description?: string;
  prompt_text?: string;
  json_schema?: Record<string, unknown>;
  video_level?: PromptVideoLevelConfig | null;
  semantic_indexing?: PromptSemanticIndexingConfig | null;
  execution_config?: Partial<PromptExecutionConfig>;
  selection_filter?: PromptSelectionFilter | null;
  clear_selection_filter?: boolean;
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

export type ImportJobStatus = 'awaiting_upload' | 'pending' | 'scanning' | 'importing' | 'completed' | 'failed' | 'cancelled';

export interface CreateImportJobRequest {
  connector_id: string;
  index_id: string;
  source_prefix?: string;
  file_pattern?: string;
  recursive?: boolean;
}

export interface ImportJobProgress {
  parts_total: number;
  parts_completed: number;
  parts_failed: number;
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
  file_id?: string;
  file_name?: string;
  error_code?: string;
  http_status?: number;
  refresh_required?: boolean;
}

export interface ImportJob {
  phase: string;
  outputs: ImportJobOutputsPage;
  execution: ImportJobExecution;
  job_id: string;
  connector_id: string | null;
  target_index_id: string | null;
  source_prefix: string;
  file_pattern: string;
  recursive: boolean;
  status: ImportJobStatus;
  source_kind?: 'connector' | 'attachments';
  run_id?: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  progress: ImportJobProgress;
  video_ids: string[];
  failed_files_next_cursor?: string | null;
  failed_files: ImportFileError[];
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
export type ExportType = 'index' | 'prompt_run' | 'search_snapshot';
export type ExportDestinationType = 'download' | 'connector';

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
  queue_status: string | null;
  attempts: number;
  max_attempts: number;
  available_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  /**
   * Authenticated first-party download endpoint from the REST status response.
   * This field is never a bearer credential.
   */
  download_url: string | null;
  file_size_bytes: number | null;
  error_message: string | null;
  last_error: string | null;
  destination_type: ExportDestinationType;
  destination_connector_id: string | null;
  destination_base_path: string | null;
  destination_subpath: string | null;
  destination_uri: string | null;
  gcs_uri: string | null;
  export_params: Record<string, unknown> | null;
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

const OAUTH_RELINKABLE_AUTHENTICATION_CODES = new Set([
  'authentication_required',
  'authentication_invalid_token',
  'authentication_invalid_oauth_token',
  'authentication_expired_token',
]);

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

  public isOAuthRelinkableAuthenticationError(): boolean {
    return (
      this.statusCode === 401
      && OAUTH_RELINKABLE_AUTHENTICATION_CODES.has(this.code)
    );
  }

  public isNotFound(): boolean {
    return this.statusCode === 404;
  }

  public isValidationError(): boolean {
    return this.statusCode === 400 || this.statusCode === 422;
  }
}
