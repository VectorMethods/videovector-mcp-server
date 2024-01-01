/**
 * Utility functions for the MCP server
 */

import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { VideoVectorApiError } from '../types/index.js';

// ============================================================================
// Error Formatting
// ============================================================================

export interface ToolHandlerResult {
  content: TextContent[];
  isError?: boolean;
  oauthAuthenticationFailure?: boolean;
}

export interface ErrorFormattingOptions {
  authenticationKind?: 'api-key' | 'oauth';
}

/**
 * A validation failure produced by this MCP server before a backend call.
 *
 * Only locally authored, user-actionable contract messages should use this
 * type. Backend and runtime errors must retain their original types so their
 * diagnostic messages remain behind the model-visible redaction boundary.
 */
export class ToolInputError extends Error {
  readonly code = 'invalid_tool_input';

  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

interface ModelSafeApiErrorPresentation {
  code: string;
  message: string;
}

/**
 * Backend error bodies cross a trust boundary before becoming model-visible.
 * Only reviewed, user-actionable codes survive that boundary, and each uses a
 * fixed message so a backend diagnostic cannot smuggle request identifiers,
 * stack traces, credentials, storage paths, or arbitrary detail into context.
 */
const MODEL_SAFE_API_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  authentication_required: 'Authentication is required to use this tool.',
  authentication_invalid_token: 'The VideoVector authorization is no longer valid.',
  authentication_invalid_oauth_token: 'The VideoVector authorization is no longer valid.',
  authentication_expired_token: 'The VideoVector authorization has expired.',
  authentication_invalid_api_key: 'The VideoVector API key was rejected.',
  invalid_api_key: 'The VideoVector API key was rejected.',
  authentication_service_unavailable: 'Authentication is temporarily unavailable.',
  authentication_oauth_service_unavailable: 'Authentication is temporarily unavailable.',
  authorization_denied: 'The signed-in account cannot perform this operation.',
  authorization_insufficient_scope: 'The signed-in account cannot perform this operation.',
  authorization_resource_access_denied: 'The signed-in account cannot access this resource.',
  authorization_plan_upgrade_required: 'This operation requires a different account plan.',
  authorization_plan_policy_unavailable: 'Account access could not be confirmed.',
  billing_payment_required: 'The account requires billing attention before this operation can continue.',
  billing_insufficient_credits: 'The account does not have enough credits for this operation.',
  billing_unavailable: 'Billing authorization is temporarily unavailable.',
  billing_error: 'The operation could not be authorized by billing.',
  llm_daily_budget_exceeded: 'The account daily AI budget has been reached.',
  llm_user_budget_exceeded: 'The account daily AI budget has been reached.',
  llm_budget_guard_open: 'AI generation is temporarily unavailable because the service budget guard is active.',
  resource_quota_exceeded: 'The account resource quota has been reached.',
  resource_rate_quota_exceeded: 'The account usage quota has been reached for the current period.',
  rate_limit_exceeded: 'Too many requests were submitted. Retry after a short delay.',
  validation_error: 'The request did not pass validation.',
  resource_not_found: 'The requested resource was not found.',
  resource_index_not_found: 'The requested index was not found.',
  resource_video_not_found: 'The requested media item was not found.',
  resource_segment_not_found: 'The requested segment was not found.',
  resource_prompt_not_found: 'The requested prompt was not found.',
  resource_prompt_run_not_found: 'The requested prompt run was not found.',
  resource_connector_not_found: 'The requested connector was not found.',
  resource_import_job_not_found: 'The requested import job was not found.',
  resource_export_not_found: 'The requested export was not found.',
  resource_webhook_not_found: 'The requested webhook was not found.',
  resource_already_exists: 'A matching resource already exists.',
  idempotency_key_reused: 'The idempotency key was already used for a different request.',
  idempotency_key_too_long: 'The idempotency key is too long.',
  idempotency_request_in_progress: 'A request with this idempotency key is still in progress.',
  metadata_export_token_configuration_invalid: 'A download link is temporarily unavailable.',
  timeout_error: 'The VideoVector service did not respond in time.',
  network_error: 'The VideoVector service is temporarily unreachable.',
  empty_response: 'The VideoVector service returned an incomplete response.',
  invalid_json_response: 'The VideoVector service returned an invalid response.',
  upload_source_error: 'The selected upload source could not be read.',
});

function modelSafeApiErrorPresentation(
  error: VideoVectorApiError
): ModelSafeApiErrorPresentation {
  const allowlistedMessage = MODEL_SAFE_API_ERROR_MESSAGES[error.code];
  if (allowlistedMessage) {
    return { code: error.code, message: allowlistedMessage };
  }

  // Preserve the broad user-action category without reflecting an unreviewed
  // backend code or message. This also keeps auth and billing behavior useful
  // when a new backend code ships before the MCP allowlist is reviewed.
  if (error.statusCode === 401) {
    return {
      code: 'authentication_failed',
      message: 'Authentication could not be confirmed.',
    };
  }
  if (error.statusCode === 403) {
    return {
      code: 'authorization_denied',
      message: 'The signed-in account cannot perform this operation.',
    };
  }
  if (error.statusCode === 402 || error.code.startsWith('billing_')) {
    return {
      code: 'billing_error',
      message: 'The operation could not be authorized by billing.',
    };
  }
  if (error.isNotFound()) {
    return {
      code: 'resource_not_found',
      message: 'The requested resource was not found.',
    };
  }
  if (error.isValidationError()) {
    return {
      code: 'validation_error',
      message: 'The request did not pass validation.',
    };
  }
  if (error.statusCode === 429) {
    return {
      code: 'rate_limit_exceeded',
      message: 'Too many requests were submitted. Retry after a short delay.',
    };
  }
  return {
    code: 'service_error',
    message: 'The VideoVector service could not complete the request.',
  };
}

export function formatError(
  error: unknown,
  options: ErrorFormattingOptions = {}
): ToolHandlerResult {
  if (error instanceof VideoVectorApiError) {
    const oauthAuthenticationFailure = (
      options.authenticationKind === 'oauth'
      && error.isOAuthRelinkableAuthenticationError()
    );
    const publicError = modelSafeApiErrorPresentation(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              code: publicError.code,
              message: publicError.message,
              recoverable: !error.isAuthError(),
              suggestion: getErrorSuggestion(error, options.authenticationKind),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
      oauthAuthenticationFailure,
    };
  }

  if (error instanceof ToolInputError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              code: error.code,
              message: error.message,
              recoverable: true,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  if (error instanceof Error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              code: 'tool_error',
              message: 'The tool could not complete the request.',
              recoverable: true,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: true,
            code: 'tool_error',
            message: 'The tool could not complete the request.',
            recoverable: true,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function getErrorSuggestion(
  error: VideoVectorApiError,
  authenticationKind?: 'api-key' | 'oauth'
): string {
  if (
    authenticationKind === 'oauth'
    && error.isOAuthRelinkableAuthenticationError()
  ) {
    return 'Reconnect the VideoVector account before retrying.';
  }

  if (error.isAuthError()) {
    if (authenticationKind === 'oauth') {
      return 'Verify that the signed-in account can access this resource.';
    }
    return 'Check that VIDEOVECTOR_API_KEY is set correctly.';
  }

  if (error.code === 'resource_quota_exceeded') {
    return 'Delete unused resources or review the account limits before retrying this operation.';
  }

  if (error.code === 'resource_rate_quota_exceeded') {
    return 'Wait until the account usage quota resets before retrying this operation.';
  }

  if (
    error.code === 'llm_daily_budget_exceeded' ||
    error.code === 'llm_user_budget_exceeded'
  ) {
    return 'Wait until the account daily AI budget resets before retrying.';
  }

  if (error.code === 'llm_budget_guard_open') {
    return 'Public LLM generation is temporarily paused by the global budget guard; retry later.';
  }

  if (error.statusCode === 402 || error.code.startsWith('billing_')) {
    return 'Review the account billing status before retrying this operation.';
  }

  if (error.isNotFound()) {
    if (error.code.includes('index')) {
      return 'Use list_indexes to discover available indexes.';
    }
    if (error.code.includes('video')) {
      return 'Verify the video_id is correct. Search results include valid video IDs.';
    }
    if (error.code.includes('prompt')) {
      return 'Use list_prompts to discover available prompts, or get_prompt to check a specific prompt.';
    }
    if (error.code.includes('run')) {
      return 'Verify the run_id is correct. Execute_prompt returns valid run IDs.';
    }
    if (error.code.includes('connector')) {
      return 'Use list_connectors to discover available connectors.';
    }
    if (error.code.includes('import') || error.code.includes('job')) {
      return 'Use list_import_jobs to discover available import jobs.';
    }
    if (error.code.includes('export')) {
      return 'Verify the export_id is correct. Use export_index_metadata or export_prompt_run to create a new export.';
    }
    return 'The requested resource was not found.';
  }

  if (error.isValidationError()) {
    return 'Check the input parameters match the expected schema.';
  }

  if (error.statusCode === 429) {
    return 'Rate limit exceeded. Wait a moment before retrying.';
  }

  if (error.isRetryable()) {
    return 'This is a temporary error. The operation can be retried.';
  }

  return 'An unexpected error occurred.';
}

// ============================================================================
// Validation
// ============================================================================

export function validateRequired<T>(
  args: Record<string, unknown>,
  field: string,
  expectedType: 'string' | 'number' | 'boolean' | 'object'
): T {
  const value = args[field];

  if (value === undefined || value === null) {
    throw new ToolInputError(`Required parameter '${field}' is missing`);
  }

  const actualType = typeof value;

  if (expectedType === 'object') {
    if (actualType !== 'object' || value === null) {
      throw new ToolInputError(`Parameter '${field}' must be an object or array`);
    }
  } else if (actualType !== expectedType) {
    throw new ToolInputError(
      `Parameter '${field}' must be a ${expectedType}, got ${actualType}`
    );
  }

  return value as T;
}

export function validateOptional<T>(
  args: Record<string, unknown>,
  field: string,
  expectedType: 'string' | 'number' | 'boolean' | 'object',
  defaultValue: T
): T {
  const value = args[field];

  if (value === undefined || value === null) {
    return defaultValue;
  }

  const actualType = typeof value;

  if (expectedType === 'object') {
    if (actualType !== 'object') {
      throw new ToolInputError(`Parameter '${field}' must be an object or array`);
    }
  } else if (actualType !== expectedType) {
    throw new ToolInputError(
      `Parameter '${field}' must be a ${expectedType}, got ${actualType}`
    );
  }

  return value as T;
}

// ============================================================================
// Response Helpers
// ============================================================================

export function createSuccessResponse(data: unknown): ToolHandlerResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ============================================================================
// Data Formatting
// ============================================================================

export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function formatDuration(startTime: number, endTime: number): string {
  const duration = endTime - startTime;
  return `${formatTimestamp(startTime)} - ${formatTimestamp(endTime)} (${duration.toFixed(1)}s)`;
}

export function truncateText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
