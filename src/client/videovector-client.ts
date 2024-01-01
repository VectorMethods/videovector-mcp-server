/**
 * VideoVector API Client
 *
 * Production-ready HTTP client for the VideoVector API with:
 * - Automatic retry with exponential backoff
 * - Proper error handling and error code mapping
 * - Request timeout handling
 * - Type-safe request/response handling
 */

import { createHash, randomUUID } from 'node:crypto';

import { PACKAGE_VERSION } from '../version.js';
import {
  type Index,
  type Video,
  type Segment,
  type SearchRequest,
  type SearchResult,
  type ImageSearchRequest,
  type ImageSearchResult,
  type MultimodalSearchRequest,
  type MultimodalSearchResult,
  type FilterSearchRequest,
  type FilterSearchResponse,
  type Prompt,
  type PromptListResponse,
  type PromptUsageStats,
  type PromptRun,
  type PromptRunCostEstimate,
  type PromptRunFailedSegmentsManifest,
  type PromptRunSegmentRetry,
  type PromptRunSegmentRetryStatus,
  type PromptRunVideoResult,
  type ExecutePromptRequest,
  type PaginatedResponse,
  type SegmentRunResult,
  type CreatePromptRequest,
  type UpdatePromptRequest,
  type TestSchemaResponse,
  type CreateGCSConnectorRequest,
  type CreateS3ConnectorRequest,
  type CreateAzureConnectorRequest,
  type Connector,
  type TestConnectionResponse,
  type BrowseFilesRequest,
  type CloudFile,
  type ConnectorScope,
  type CreateImportJobRequest,
  type ImportJob,
  type ImportJobStatus,
  type CreateIndexRequest,
  type VideoStatus,
  type ExportDestinationRequest,
  type ExportDownloadUrlResponse,
  type ExportJob,
  type IndexExportRequest,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
  type Webhook,
  type WebhookWithSecret,
  type WebhookDelivery,
  type TestWebhookResponse,
  VideoVectorApiError,
} from '../types/index.js';

// ============================================================================
// Configuration
// ============================================================================

export interface VideoVectorClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://api.vectormethods.com/api/v2';
const DEFAULT_TIMEOUT = 90000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];
const INITIAL_RETRY_DELAY_MS = 1000;
const AUTOMATIC_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXPORT_STATUS_VALUES = new Set(['pending', 'processing', 'completed', 'failed']);
const EXPORT_TYPE_VALUES = new Set(['index', 'prompt_run']);
const EXPORT_DESTINATION_VALUES = new Set(['download', 'connector']);
const EXPORT_QUEUE_STATUS_VALUES = new Set([
  'queued',
  'leased',
  'running',
  'failed',
  'succeeded',
  'dead_letter',
]);
const PUBLIC_EXPORT_PARAM_FIELDS = new Set([
  'prompt_run_ids',
  'destination_connector_id',
  'destination_base_path',
  'destination_subpath',
]);
const EXPORT_DOWNLOAD_RESPONSE_FIELDS = [
  'destination_connector_id',
  'destination_type',
  'download_url',
  'export_id',
  'status',
] as const;
const MIN_EXPORT_DOWNLOAD_TOKEN_LENGTH = 32;
const MAX_EXPORT_DOWNLOAD_TOKEN_LENGTH = 2048;
const EXPORT_DOWNLOAD_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[]
): boolean {
  const actualFields = Object.keys(value).sort();
  return (
    actualFields.length === expectedFields.length
    && actualFields.every((field, index) => field === expectedFields[index])
  );
}

function canonicalExportDownloadPath(exportId: string): string {
  return `/api/v2/exports/${encodeURIComponent(exportId)}/download`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return (
    value === null
    || (typeof value === 'string' && value.trim().length > 0)
  );
}

function isNullableTimestamp(value: unknown): value is string | null {
  return (
    value === null
    || (
      typeof value === 'string'
      && value.trim().length > 0
      && Number.isFinite(Date.parse(value))
    )
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isPublicExportParams(value: unknown): value is Record<string, unknown> | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).some((field) => !PUBLIC_EXPORT_PARAM_FIELDS.has(field))) {
    return false;
  }

  const promptRunIds = value.prompt_run_ids;
  if (
    promptRunIds !== undefined
    && promptRunIds !== null
    && (
      !Array.isArray(promptRunIds)
      || promptRunIds.some(
        (runId) => typeof runId !== 'string' || runId.trim().length === 0
      )
    )
  ) {
    return false;
  }

  return (
    (value.destination_connector_id === undefined
      || isNullableNonEmptyString(value.destination_connector_id))
    && (value.destination_base_path === undefined
      || isNullableString(value.destination_base_path))
    && (value.destination_subpath === undefined
      || isNullableString(value.destination_subpath))
  );
}

function createIdempotencyKey(prefix: string, providedKey?: string): string {
  const candidate = providedKey?.trim();
  if (candidate) {
    return candidate;
  }
  return `${prefix}:${randomUUID().replace(/-/g, '')}`;
}

function normalizeExportRequestBody<T extends object>(request: T): Partial<T> | undefined {
  const requestRecord = request as Record<string, unknown>;
  const body = Object.fromEntries(
    Object.entries(requestRecord).filter(([, value]) => {
      if (value === undefined || value === null || value === '') {
        return false;
      }
      if (Array.isArray(value) && value.length === 0) {
        return false;
      }
      return true;
    })
  ) as Partial<T>;
  return Object.keys(body).length > 0 ? body : undefined;
}

function normalizeConnectorCreateBody<T extends { export_base_path?: unknown }>(request: T): T {
  const body = { ...request };
  if (
    body.export_base_path === undefined
    || body.export_base_path === null
    || body.export_base_path === ''
  ) {
    delete body.export_base_path;
  }
  return body;
}

function hasStableIdempotencyKey(headers?: Record<string, string>): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === 'idempotency-key' && value.trim().length > 0
  );
}

function isAutomaticRetryAllowed(
  method: string,
  headers?: Record<string, string>
): boolean {
  return (
    AUTOMATIC_RETRY_METHODS.has(method.toUpperCase()) ||
    hasStableIdempotencyKey(headers)
  );
}

// ============================================================================
// Client Implementation
// ============================================================================

export class VideoVectorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiOrigin: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: VideoVectorClientConfig) {
    if (!config.apiKey) {
      throw new Error('VideoVector API key is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiOrigin = new URL(this.baseUrl).origin;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  getIdempotencyScope(): string {
    return createHash('sha256')
      .update(`${this.baseUrl}|${this.apiKey}`)
      .digest('hex');
  }

  // ==========================================================================
  // HTTP Methods
  // ==========================================================================

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | string[] | undefined>;
      headers?: Record<string, string>;
      retryCount?: number;
    } = {}
  ): Promise<T> {
    const { body, query, headers: extraHeaders, retryCount = 0 } = options;
    const allowRetry = isAutomaticRetryAllowed(method, extraHeaders);

    // Build URL with query parameters
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          if (Array.isArray(value)) {
            // For array values, append each element as a separate query parameter
            // This produces: ?key=val1&key=val2&key=val3
            for (const item of value) {
              url.searchParams.append(key, String(item));
            }
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Accept': 'application/json',
      'User-Agent': `videovector-mcp/${PACKAGE_VERSION}`,
      ...extraHeaders,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle non-2xx responses
      if (!response.ok) {
        const errorBody = await this.parseErrorResponse(response);

        // Check if we should retry
        if (
          allowRetry &&
          retryCount < this.maxRetries &&
          RETRY_STATUS_CODES.includes(response.status)
        ) {
          const delay = this.calculateRetryDelay(response, retryCount);
          await this.sleep(delay);
          return this.request<T>(method, path, {
            body,
            query,
            headers: extraHeaders,
            retryCount: retryCount + 1,
          });
        }

        throw new VideoVectorApiError(
          errorBody.message,
          errorBody.code,
          response.status,
          errorBody.details,
          errorBody.requestId
        );
      }

      // Parse successful response
      const text = await response.text();
      if (!text) {
        // Empty response body is unexpected for this JSON API - all endpoints should return valid JSON
        // Throwing an error surfaces the issue immediately rather than causing confusing downstream errors
        // (e.g., returning {} when T is an array type would crash on iteration)
        throw new VideoVectorApiError(
          'Received empty response body from API',
          'empty_response',
          response.status,
          { url: url.toString(), method }
        );
      }
      return this.parseSuccessfulJson<T>(text);
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new VideoVectorApiError(
          'Request timed out',
          'timeout_error',
          408
        );
      }

      // Handle network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        if (allowRetry && retryCount < this.maxRetries) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);
          await this.sleep(delay);
          return this.request<T>(method, path, {
            body,
            query,
            headers: extraHeaders,
            retryCount: retryCount + 1,
          });
        }
        throw new VideoVectorApiError(
          'Network error: Unable to connect to VideoVector API',
          'network_error',
          0
        );
      }

      // Re-throw VideoVectorApiError
      if (error instanceof VideoVectorApiError) {
        throw error;
      }

      // Wrap unknown errors
      throw new VideoVectorApiError(
        error instanceof Error ? error.message : 'Unknown error occurred',
        'unknown_error',
        500
      );
    }
  }

  private parseSuccessfulJson<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      // Never surface JSON parser diagnostics. Modern runtimes may include a
      // fragment of the response body, which can contain a freshly minted
      // bearer capability or another credential.
      throw new VideoVectorApiError(
        'API returned malformed JSON',
        'invalid_json_response',
        502
      );
    }
  }

  private async parseErrorResponse(response: Response): Promise<{
    message: string;
    code: string;
    details?: Record<string, unknown>;
    requestId?: string;
  }> {
    try {
      const body = (await response.json()) as Record<string, unknown>;

      // Handle standard error format
      if (body.error && typeof body.error === 'object') {
        const error = body.error as Record<string, unknown>;
        return {
          message: (error.message as string) ?? 'Unknown error',
          code: (error.code as string) ?? `http_${response.status}`,
          details: error.details as Record<string, unknown> | undefined,
          requestId: error.request_id as string | undefined,
        };
      }

      // Handle FastAPI detail format
      if (body.detail !== undefined) {
        const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
        return {
          message: detail,
          code: `http_${response.status}`,
        };
      }

      // Fallback
      return {
        message: `API request failed with HTTP ${response.status}`,
        code: `http_${response.status}`,
      };
    } catch {
      return {
        message: `API request failed with HTTP ${response.status}`,
        code: `http_${response.status}`,
      };
    }
  }

  private invalidExportStatusResponse(): never {
    throw new VideoVectorApiError(
      'API returned an invalid export status response',
      'invalid_export_status_response',
      502
    );
  }

  private validateExportStatus(
    response: unknown,
    expectedExportId?: string
  ): ExportJob {
    if (!isRecord(response)) {
      return this.invalidExportStatusResponse();
    }

    const exportId = response.export_id;
    const exportType = response.export_type;
    const targetId = response.target_id;
    const createdAt = response.created_at;
    const status = response.status;
    const queueStatus = response.queue_status;
    const attempts = response.attempts;
    const maxAttempts = response.max_attempts;
    const availableAt = response.available_at;
    const startedAt = response.started_at;
    const completedAt = response.completed_at;
    const updatedAt = response.updated_at;
    const destinationType = response.destination_type;
    const destinationConnectorId = response.destination_connector_id;
    const downloadUrl = response.download_url;
    const fileSizeBytes = response.file_size_bytes;
    const errorMessage = response.error_message;
    const lastError = response.last_error;
    const destinationBasePath = response.destination_base_path;
    const destinationSubpath = response.destination_subpath;
    const destinationUri = response.destination_uri;
    const gcsUri = response.gcs_uri;
    const exportParams = response.export_params;
    if (
      typeof exportId !== 'string'
      || exportId.trim().length === 0
      || (expectedExportId !== undefined && exportId !== expectedExportId)
      || typeof exportType !== 'string'
      || !EXPORT_TYPE_VALUES.has(exportType)
      || typeof targetId !== 'string'
      || targetId.trim().length === 0
      || !isNullableTimestamp(createdAt)
      || typeof status !== 'string'
      || !EXPORT_STATUS_VALUES.has(status)
      || !(
        queueStatus === null
        || (
          typeof queueStatus === 'string'
          && EXPORT_QUEUE_STATUS_VALUES.has(queueStatus)
        )
      )
      || !isNonNegativeInteger(attempts)
      || !Number.isInteger(maxAttempts)
      || Number(maxAttempts) < 1
      || !isNullableTimestamp(availableAt)
      || !isNullableTimestamp(startedAt)
      || !isNullableTimestamp(completedAt)
      || !isNullableTimestamp(updatedAt)
      || typeof destinationType !== 'string'
      || !EXPORT_DESTINATION_VALUES.has(destinationType)
      || !(
        destinationConnectorId === null
        || (
          typeof destinationConnectorId === 'string'
          && destinationConnectorId.trim().length > 0
        )
      )
      || !(downloadUrl === null || typeof downloadUrl === 'string')
      || !isNullableNonNegativeInteger(fileSizeBytes)
      || !isNullableString(errorMessage)
      || !isNullableString(lastError)
      || !isNullableString(destinationBasePath)
      || !isNullableString(destinationSubpath)
      || !isNullableNonEmptyString(destinationUri)
      || !isNullableNonEmptyString(gcsUri)
      || !isPublicExportParams(exportParams)
    ) {
      return this.invalidExportStatusResponse();
    }

    const directDestinationIsConsistent = (
      destinationType !== 'download' || destinationConnectorId === null
    );
    const connectorDestinationIsConsistent = (
      destinationType !== 'connector'
      || (
        typeof destinationConnectorId === 'string'
        && destinationConnectorId.trim().length > 0
      )
    );
    const expectedDownloadUrl = canonicalExportDownloadPath(exportId);
    const authenticatedDownloadIsConsistent = (
      downloadUrl === null
      || (
        status === 'completed'
        && queueStatus === 'succeeded'
        && destinationType === 'download'
        && gcsUri !== null
        && downloadUrl === expectedDownloadUrl
      )
    );
    const unavailableDownloadIsNull = (
      (status === 'completed' && destinationType === 'download')
      || downloadUrl === null
    );
    const destinationUriIsConsistent = (
      destinationType === 'download'
        ? destinationUri === null
        : destinationUri === gcsUri
    );
    const exportParamProjectionIsConsistent = (
      !isRecord(exportParams)
      || (
        (exportParams.destination_connector_id === undefined
          || exportParams.destination_connector_id === destinationConnectorId)
        && (exportParams.destination_base_path === undefined
          || exportParams.destination_base_path === destinationBasePath)
        && (exportParams.destination_subpath === undefined
          || exportParams.destination_subpath === destinationSubpath)
      )
    );
    if (
      !directDestinationIsConsistent
      || !connectorDestinationIsConsistent
      || !authenticatedDownloadIsConsistent
      || !unavailableDownloadIsNull
      || !destinationUriIsConsistent
      || !exportParamProjectionIsConsistent
    ) {
      return this.invalidExportStatusResponse();
    }

    return {
      export_id: exportId,
      export_type: exportType as ExportJob['export_type'],
      target_id: targetId,
      created_at: createdAt,
      status: status as ExportJob['status'],
      queue_status: queueStatus,
      attempts,
      max_attempts: maxAttempts as number,
      available_at: availableAt,
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: updatedAt,
      download_url: downloadUrl,
      file_size_bytes: fileSizeBytes,
      error_message: errorMessage,
      last_error: lastError,
      destination_type: destinationType as ExportJob['destination_type'],
      destination_connector_id: destinationConnectorId,
      destination_base_path: destinationBasePath,
      destination_subpath: destinationSubpath,
      destination_uri: destinationUri,
      gcs_uri: gcsUri,
      export_params: exportParams,
    };
  }

  private validateExportDownloadUrl(
    downloadUrl: string,
    exportId: string
  ): boolean {
    if (downloadUrl !== downloadUrl.trim()) {
      return false;
    }

    let parsed: URL;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      return false;
    }

    if (
      parsed.protocol !== 'https:'
      || parsed.origin !== this.apiOrigin
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || parsed.pathname !== canonicalExportDownloadPath(exportId)
    ) {
      return false;
    }

    const queryFields = Array.from(parsed.searchParams.keys());
    const tokens = parsed.searchParams.getAll('token');
    if (
      queryFields.length !== 1
      || queryFields[0] !== 'token'
      || tokens.length !== 1
    ) {
      return false;
    }

    const token = tokens[0];
    if (
      token === undefined
      || token !== token.trim()
      || token.length < MIN_EXPORT_DOWNLOAD_TOKEN_LENGTH
      || token.length > MAX_EXPORT_DOWNLOAD_TOKEN_LENGTH
      || !EXPORT_DOWNLOAD_TOKEN_PATTERN.test(token)
      || parsed.search !== `?token=${encodeURIComponent(token)}`
    ) {
      return false;
    }

    return true;
  }

  private calculateRetryDelay(response: Response, retryCount: number): number {
    // Check for Retry-After header
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
    }

    // Exponential backoff with jitter
    const baseDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);
    const jitter = Math.random() * 0.3 * baseDelay;
    return baseDelay + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Index Operations
  // ==========================================================================

  async listIndexes(includeDefaults: boolean = true): Promise<Index[]> {
    return this.request<Index[]>('GET', '/indexes', {
      query: { include_defaults: includeDefaults },
    });
  }

  async getIndex(indexId: string): Promise<Index> {
    return this.request<Index>('GET', `/indexes/${encodeURIComponent(indexId)}`);
  }

  async getVideosInIndex(
    indexId: string,
    limit: number = 50,
    cursor?: string
  ): Promise<PaginatedResponse<Video>> {
    return this.request<PaginatedResponse<Video>>(
      'GET',
      `/indexes/${encodeURIComponent(indexId)}/videos`,
      { query: { limit, cursor } }
    );
  }

  // ==========================================================================
  // Video Operations
  // ==========================================================================

  async getVideo(videoId: string): Promise<Video> {
    return this.request<Video>('GET', `/videos/${encodeURIComponent(videoId)}`);
  }

  async getVideoSegments(
    videoId: string,
    options: {
      runId?: string;
      latestRun?: boolean;
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<PaginatedResponse<Segment>> {
    const { runId, latestRun, limit = 50, cursor } = options;
    return this.request<PaginatedResponse<Segment>>(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/segments`,
      {
        query: {
          run_id: runId,
          latest_run: latestRun,
          limit,
          cursor,
        },
      }
    );
  }

  // ==========================================================================
  // Search Operations
  // ==========================================================================

  async searchVideos(
    indexId: string,
    request: SearchRequest
  ): Promise<SearchResult[]> {
    return this.request<SearchResult[]>(
      'POST',
      `/indexes/${encodeURIComponent(indexId)}/search`,
      { body: request }
    );
  }

  async searchByImage(
    indexId: string,
    request: ImageSearchRequest
  ): Promise<ImageSearchResult[]> {
    return this.request<ImageSearchResult[]>(
      'POST',
      `/indexes/${encodeURIComponent(indexId)}/image-search`,
      { body: request }
    );
  }

  async searchMultimodal(
    indexId: string,
    request: MultimodalSearchRequest
  ): Promise<MultimodalSearchResult[]> {
    return this.request<MultimodalSearchResult[]>(
      'POST',
      `/indexes/${encodeURIComponent(indexId)}/multimodal-search`,
      { body: request }
    );
  }

  async filterSearch(
    indexId: string,
    request: FilterSearchRequest
  ): Promise<FilterSearchResponse> {
    return this.request<FilterSearchResponse>(
      'POST',
      `/search/filter/${encodeURIComponent(indexId)}`,
      { body: request }
    );
  }

  // ==========================================================================
  // Prompt Operations
  // ==========================================================================

  async listPrompts(
    activeOnly: boolean = true,
    includeDefaults: boolean = true
  ): Promise<PromptListResponse> {
    return this.request<PromptListResponse>('GET', '/prompts', {
      query: { active_only: activeOnly, include_defaults: includeDefaults },
    });
  }

  async getPrompt(promptId: string): Promise<Prompt> {
    return this.request<Prompt>('GET', `/prompts/${encodeURIComponent(promptId)}`);
  }

  // ==========================================================================
  // Prompt Run Operations
  // ==========================================================================

  async executePrompt(
    request: ExecutePromptRequest,
    idempotencyKey?: string
  ): Promise<PromptRun> {
    return this.request<PromptRun>('POST', '/prompt-runs/execute', {
      body: request,
      headers: { 'Idempotency-Key': createIdempotencyKey('prompt-run-execute', idempotencyKey) },
    });
  }

  async estimatePromptRun(request: ExecutePromptRequest): Promise<PromptRunCostEstimate> {
    return this.request<PromptRunCostEstimate>('POST', '/prompt-runs/estimate', {
      body: request,
    });
  }

  async listPromptRuns(options: {
    indexId?: string;
    videoId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<PaginatedResponse<PromptRun> | PromptRun[]> {
    const { indexId, videoId, limit, cursor } = options;
    const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : 50;
    const normalizedLimit = Math.min(Math.max(finiteLimit, 1), 200);
    const hasExplicitLimit = limit !== undefined;
    const defaultedIndexLimit = hasExplicitLimit ? normalizedLimit : 50;
    const defaultedUserLimit = hasExplicitLimit ? normalizedLimit : 200;

    if (indexId && videoId) {
      throw new Error('Provide either indexId or videoId, not both.');
    }
    if (cursor && !indexId) {
      throw new Error('cursor is only supported when listing prompt runs for an index.');
    }
    if (indexId && defaultedIndexLimit > 100) {
      throw new Error('limit cannot exceed 100 when listing prompt runs for an index.');
    }

    if (indexId) {
      return this.request<PaginatedResponse<PromptRun>>(
        'GET',
        `/indexes/${encodeURIComponent(indexId)}/prompt-runs`,
        { query: { limit: defaultedIndexLimit, cursor } }
      );
    }

    if (videoId) {
      const query = hasExplicitLimit ? { limit: normalizedLimit } : undefined;
      return this.request<PromptRun[]>(
        'GET',
        `/videos/${encodeURIComponent(videoId)}/prompt-runs`,
        { query }
      );
    }

    return this.request<PromptRun[]>('GET', '/prompt-runs', {
      query: { limit: defaultedUserLimit },
    });
  }

  async getPromptRun(runId: string): Promise<PromptRun> {
    return this.request<PromptRun>(
      'GET',
      `/prompt-runs/${encodeURIComponent(runId)}`
    );
  }

  async cancelPromptRun(runId: string, idempotencyKey?: string): Promise<PromptRun> {
    return this.request<PromptRun>(
      'POST',
      `/prompt-runs/${encodeURIComponent(runId)}/cancel`,
      {
        headers: {
          'Idempotency-Key': createIdempotencyKey('prompt-run-cancel', idempotencyKey),
        },
      }
    );
  }

  async getPromptRunResults(
    runId: string,
    options: {
      videoId: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<PaginatedResponse<SegmentRunResult>> {
    const { videoId, limit = 50, cursor } = options;
    return this.request<PaginatedResponse<SegmentRunResult>>(
      'GET',
      `/prompt-runs/${encodeURIComponent(runId)}/results`,
      {
        query: { video_id: videoId, limit, cursor },
      }
    );
  }

  async getIndexPromptRuns(
    indexId: string,
    limit: number = 50,
    cursor?: string
  ): Promise<PaginatedResponse<PromptRun>> {
    return this.request<PaginatedResponse<PromptRun>>(
      'GET',
      `/indexes/${encodeURIComponent(indexId)}/prompt-runs`,
      { query: { limit, cursor } }
    );
  }

  async getPromptRunVideoResult(runId: string, videoId: string): Promise<PromptRunVideoResult> {
    return this.request<PromptRunVideoResult>(
      'GET',
      `/prompt-runs/${encodeURIComponent(runId)}/videos/${encodeURIComponent(videoId)}/video-result`
    );
  }

  async getPromptRunFailedSegments(runId: string): Promise<PromptRunFailedSegmentsManifest> {
    return this.request<PromptRunFailedSegmentsManifest>(
      'GET',
      `/prompt-runs/${encodeURIComponent(runId)}/failed-segments`
    );
  }

  async retryPromptRunSegment(
    runId: string,
    videoId: string,
    segmentId: string,
    idempotencyKey?: string
  ): Promise<PromptRunSegmentRetry> {
    return this.request<PromptRunSegmentRetry>(
      'POST',
      `/prompt-runs/${encodeURIComponent(runId)}/videos/${encodeURIComponent(videoId)}/segments/${encodeURIComponent(segmentId)}/retry`,
      {
        headers: {
          'Idempotency-Key': createIdempotencyKey('prompt-run-segment-retry', idempotencyKey),
        },
      }
    );
  }

  async getPromptRunSegmentRetryStatus(
    runId: string,
    videoId: string,
    segmentId: string,
    retryId: string
  ): Promise<PromptRunSegmentRetryStatus> {
    return this.request<PromptRunSegmentRetryStatus>(
      'GET',
      `/prompt-runs/${encodeURIComponent(runId)}/videos/${encodeURIComponent(videoId)}/segments/${encodeURIComponent(segmentId)}/retries/${encodeURIComponent(retryId)}`
    );
  }

  // ==========================================================================
  // Prompt Management Operations
  // ==========================================================================

  async createPrompt(request: CreatePromptRequest, idempotencyKey?: string): Promise<Prompt> {
    return this.request<Prompt>('POST', '/prompts', {
      body: request,
      headers: { 'Idempotency-Key': createIdempotencyKey('prompt-create', idempotencyKey) },
    });
  }

  async getPromptDetail(promptId: string): Promise<Prompt> {
    return this.request<Prompt>(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}`
    );
  }

  async updatePrompt(
    promptId: string,
    request: UpdatePromptRequest,
    idempotencyKey?: string
  ): Promise<Prompt> {
    return this.request<Prompt>(
      'PUT',
      `/prompts/${encodeURIComponent(promptId)}`,
      {
        body: request,
        headers: { 'Idempotency-Key': createIdempotencyKey('prompt-update', idempotencyKey) },
      }
    );
  }

  async testPromptSchema(
    jsonSchema: Record<string, unknown>,
    sampleData: Record<string, unknown>
  ): Promise<TestSchemaResponse> {
    return this.request<TestSchemaResponse>('POST', '/prompts/test-schema', {
      body: {
        json_schema: jsonSchema,
        sample_data: sampleData,
      },
    });
  }

  async getPromptUsage(promptId: string): Promise<PromptUsageStats> {
    return this.request<PromptUsageStats>(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/usage`
    );
  }

  // ==========================================================================
  // Cloud Connector Operations
  // ==========================================================================

  async createGCSConnector(
    request: CreateGCSConnectorRequest,
    idempotencyKey?: string
  ): Promise<Connector> {
    // GCS connector uses multipart form data with file upload
    // Use a factory function to create fresh FormData for each attempt.
    // The backend owns durable connector-create idempotency across every
    // provider. A fresh FormData factory preserves the option to retry without
    // introducing a process-local competing cache.
    const createFormData = (): FormData => {
      const formData = new FormData();
      formData.append('name', request.name);
      formData.append('bucket', request.bucket);
      formData.append('gcp_project_id', request.gcp_project_id);
      for (const scope of request.scopes ?? ['import']) {
        formData.append('scopes', scope as ConnectorScope);
      }
      if (request.export_base_path) {
        formData.append('export_base_path', request.export_base_path);
      }
      if (request.import_mode) {
        formData.append('import_mode', request.import_mode);
      }

      // Create a Blob from the credentials JSON
      const credentialsBlob = new Blob(
        [JSON.stringify(request.credentials_json)],
        { type: 'application/json' }
      );
      formData.append('credentials_file', credentialsBlob, 'credentials.json');
      return formData;
    };

    return this.requestFormData<Connector>(
      'POST',
      '/connectors/gcs',
      createFormData,
      { 'Idempotency-Key': createIdempotencyKey('connector-create-gcs', idempotencyKey) }
    );
  }

  async createS3Connector(
    request: CreateS3ConnectorRequest,
    idempotencyKey?: string
  ): Promise<Connector> {
    const body = normalizeConnectorCreateBody(request);
    return this.request<Connector>('POST', '/connectors/s3', {
      body,
      headers: { 'Idempotency-Key': createIdempotencyKey('connector-create-s3', idempotencyKey) },
    });
  }

  async createAzureConnector(
    request: CreateAzureConnectorRequest,
    idempotencyKey?: string
  ): Promise<Connector> {
    const body = normalizeConnectorCreateBody(request);
    return this.request<Connector>('POST', '/connectors/azure', {
      body,
      headers: { 'Idempotency-Key': createIdempotencyKey('connector-create-azure', idempotencyKey) },
    });
  }

  async listConnectors(): Promise<Connector[]> {
    return this.request<Connector[]>('GET', '/connectors');
  }

  async getConnector(connectorId: string): Promise<Connector> {
    return this.request<Connector>(
      'GET',
      `/connectors/${encodeURIComponent(connectorId)}`
    );
  }

  async testConnector(connectorId: string): Promise<TestConnectionResponse> {
    return this.request<TestConnectionResponse>(
      'POST',
      `/connectors/${encodeURIComponent(connectorId)}/test`
    );
  }

  async browseConnectorFiles(
    connectorId: string,
    request: BrowseFilesRequest = {}
  ): Promise<CloudFile[]> {
    return this.request<CloudFile[]>(
      'POST',
      `/connectors/${encodeURIComponent(connectorId)}/browse`,
      { body: request }
    );
  }

  // ==========================================================================
  // Import Job Operations
  // ==========================================================================

  async createImportJob(request: CreateImportJobRequest, idempotencyKey?: string): Promise<ImportJob> {
    return this.request<ImportJob>('POST', '/import-jobs', {
      body: request,
      headers: { 'Idempotency-Key': createIdempotencyKey('import-job-create', idempotencyKey) },
    });
  }

  async listImportJobs(statusFilter?: ImportJobStatus): Promise<ImportJob[]> {
    return this.request<ImportJob[]>('GET', '/import-jobs', {
      query: statusFilter ? { status: statusFilter } : undefined,
    });
  }

  async getImportJob(jobId: string): Promise<ImportJob> {
    return this.request<ImportJob>(
      'GET',
      `/import-jobs/${encodeURIComponent(jobId)}`
    );
  }

  async cancelImportJob(jobId: string, idempotencyKey?: string): Promise<ImportJob> {
    return this.request<ImportJob>(
      'POST',
      `/import-jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        headers: { 'Idempotency-Key': createIdempotencyKey('import-job-cancel', idempotencyKey) },
      }
    );
  }

  // ==========================================================================
  // Index Management Operations
  // ==========================================================================

  async createIndex(request: CreateIndexRequest, idempotencyKey?: string): Promise<Index> {
    return this.request<Index>('POST', '/indexes', {
      body: request,
      headers: { 'Idempotency-Key': createIdempotencyKey('index-create', idempotencyKey) },
    });
  }

  // ==========================================================================
  // Video Status Operations
  // ==========================================================================

  async getVideosStatus(videoIds: string[]): Promise<VideoStatus[]> {
    return this.request<VideoStatus[]>('POST', '/videos/batch/status', {
      body: { video_ids: videoIds },
    });
  }

  // ==========================================================================
  // Export Operations
  // ==========================================================================

  async exportIndexMetadata(
    indexId: string,
    request: IndexExportRequest = {},
    idempotencyKey?: string
  ): Promise<{ export_id: string; status: string }> {
    const body = normalizeExportRequestBody(request);
    return this.request<{ export_id: string; status: string }>(
      'POST',
      `/exports/index/${encodeURIComponent(indexId)}`,
      {
        body,
        headers: { 'Idempotency-Key': createIdempotencyKey('export-index-create', idempotencyKey) },
      }
    );
  }

  async exportPromptRun(
    runId: string,
    request: ExportDestinationRequest = {},
    idempotencyKey?: string
  ): Promise<{ export_id: string; status: string }> {
    const body = normalizeExportRequestBody(request);
    return this.request<{ export_id: string; status: string }>(
      'POST',
      `/exports/prompt-run/${encodeURIComponent(runId)}`,
      {
        body,
        headers: { 'Idempotency-Key': createIdempotencyKey('export-prompt-run-create', idempotencyKey) },
      }
    );
  }

  async listExports(limit: number = 50): Promise<ExportJob[]> {
    const response = await this.request<unknown>('GET', '/exports', {
      query: { limit },
    });
    if (!Array.isArray(response)) {
      return this.invalidExportStatusResponse();
    }
    return response.map((job) => this.validateExportStatus(job));
  }

  async getExportStatus(exportId: string): Promise<ExportJob> {
    const response = await this.request<unknown>(
      'GET',
      `/exports/${encodeURIComponent(exportId)}`
    );
    return this.validateExportStatus(response, exportId);
  }

  async mintExportDownloadUrl(
    exportId: string
  ): Promise<ExportDownloadUrlResponse> {
    // Minting creates a fresh credential, so this POST deliberately carries no
    // idempotency key and is never retried after an ambiguous network result.
    const response = await this.request<unknown>(
      'POST',
      `/exports/${encodeURIComponent(exportId)}/download-url`
    );
    const body = isRecord(response) ? response : null;
    const responseExportId = body?.export_id;
    const status = body?.status;
    const destinationType = body?.destination_type;
    const destinationConnectorId = body?.destination_connector_id;
    const downloadUrl = body?.download_url;
    const validStatus = (
      status === 'pending'
      || status === 'processing'
      || status === 'completed'
      || status === 'failed'
    );
    const validDestinationType = (
      destinationType === 'download' || destinationType === 'connector'
    );
    const validConnectorId = (
      destinationConnectorId === null
      || (
        typeof destinationConnectorId === 'string'
        && destinationConnectorId.trim().length > 0
      )
    );
    const validDownloadUrl = (
      downloadUrl === null
      || (
        typeof downloadUrl === 'string'
        && this.validateExportDownloadUrl(downloadUrl, exportId)
      )
    );
    const consistentDestination = (
      (
        destinationType === 'download'
        && destinationConnectorId === null
      )
      || (
        destinationType === 'connector'
        && typeof destinationConnectorId === 'string'
        && destinationConnectorId.trim().length > 0
        && downloadUrl === null
      )
    );
    const consistentBearer = (
      downloadUrl === null
      || (status === 'completed' && destinationType === 'download')
    );
    if (
      body === null
      || !hasExactFields(body, EXPORT_DOWNLOAD_RESPONSE_FIELDS)
      || responseExportId !== exportId
      || !validStatus
      || !validDestinationType
      || !validConnectorId
      || !validDownloadUrl
      || !consistentDestination
      || !consistentBearer
    ) {
      throw new VideoVectorApiError(
        'API returned an invalid export download URL response',
        'invalid_export_download_url_response',
        502
      );
    }
    return response as ExportDownloadUrlResponse;
  }

  // ==========================================================================
  // Webhook Operations
  // ==========================================================================

  async createWebhook(
    request: CreateWebhookRequest,
    idempotencyKey?: string
  ): Promise<WebhookWithSecret> {
    return this.request<WebhookWithSecret>('POST', '/webhooks', {
      body: request,
      headers: { 'Idempotency-Key': createIdempotencyKey('webhook-create', idempotencyKey) },
    });
  }

  async listWebhooks(): Promise<Webhook[]> {
    return this.request<Webhook[]>('GET', '/webhooks');
  }

  async getWebhook(webhookId: string): Promise<Webhook> {
    return this.request<Webhook>(
      'GET',
      `/webhooks/${encodeURIComponent(webhookId)}`
    );
  }

  async updateWebhook(
    webhookId: string,
    request: UpdateWebhookRequest,
    idempotencyKey?: string
  ): Promise<Webhook> {
    return this.request<Webhook>(
      'PATCH',
      `/webhooks/${encodeURIComponent(webhookId)}`,
      {
        body: request,
        headers: { 'Idempotency-Key': createIdempotencyKey('webhook-update', idempotencyKey) },
      }
    );
  }

  async testWebhook(webhookId: string, idempotencyKey?: string): Promise<TestWebhookResponse> {
    return this.request<TestWebhookResponse>(
      'POST',
      `/webhooks/${encodeURIComponent(webhookId)}/test`,
      {
        headers: { 'Idempotency-Key': createIdempotencyKey('webhook-test', idempotencyKey) },
      }
    );
  }

  async listWebhookDeliveries(
    webhookId: string,
    options: { status?: string; limit?: number } = {}
  ): Promise<WebhookDelivery[]> {
    const { status, limit = 50 } = options;
    return this.request<WebhookDelivery[]>(
      'GET',
      `/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      { query: { status, limit } }
    );
  }

  async getWebhookEvents(): Promise<string[]> {
    return this.request<string[]>('GET', '/webhooks/events');
  }

  // ==========================================================================
  // Form Data Request Helper
  // ==========================================================================

  /**
   * Make a request with FormData body.
   * Multipart requests are currently single-attempt. The backend still owns
   * the durable request identity, including response-loss recovery.
   */
  private async requestFormData<T>(
    method: string,
    path: string,
    createFormData: () => FormData,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Accept': 'application/json',
      'User-Agent': `videovector-mcp/${PACKAGE_VERSION}`,
      ...extraHeaders,
      // Note: Content-Type is not set - fetch will set it with boundary for FormData
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Create fresh FormData for this attempt
      const formData = createFormData();

      const response = await fetch(url.toString(), {
        method,
        headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await this.parseErrorResponse(response);

        throw new VideoVectorApiError(
          errorBody.message,
          errorBody.code,
          response.status,
          errorBody.details,
          errorBody.requestId
        );
      }

      const text = await response.text();
      if (!text) {
        // Empty response body is unexpected for this JSON API - all endpoints should return valid JSON
        throw new VideoVectorApiError(
          'Received empty response body from API',
          'empty_response',
          response.status,
          { url: url.toString(), method }
        );
      }
      return this.parseSuccessfulJson<T>(text);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new VideoVectorApiError('Request timed out', 'timeout_error', 408);
      }

      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new VideoVectorApiError(
          'Network error: Unable to connect to VideoVector API',
          'network_error',
          0
        );
      }

      if (error instanceof VideoVectorApiError) {
        throw error;
      }

      throw new VideoVectorApiError(
        error instanceof Error ? error.message : 'Unknown error occurred',
        'unknown_error',
        500
      );
    }
  }
}
