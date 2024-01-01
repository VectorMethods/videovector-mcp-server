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
}

export function formatError(error: unknown): ToolHandlerResult {
  if (error instanceof VideoVectorApiError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              code: error.code,
              message: error.message,
              details: error.details,
              request_id: error.requestId,
              recoverable: !error.isAuthError(),
              suggestion: getErrorSuggestion(error),
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

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: true,
            message: String(error),
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

function getErrorSuggestion(error: VideoVectorApiError): string {
  if (error.isAuthError()) {
    return 'Check that VIDEOVECTOR_API_KEY is set correctly. Legacy VIDEOSEARCH_API_KEY is also accepted during migration.';
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
    throw new Error(`Required parameter '${field}' is missing`);
  }

  const actualType = typeof value;

  if (expectedType === 'object') {
    if (actualType !== 'object' || value === null) {
      throw new Error(`Parameter '${field}' must be an object or array`);
    }
  } else if (actualType !== expectedType) {
    throw new Error(`Parameter '${field}' must be a ${expectedType}, got ${actualType}`);
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
      throw new Error(`Parameter '${field}' must be an object or array`);
    }
  } else if (actualType !== expectedType) {
    throw new Error(`Parameter '${field}' must be a ${expectedType}, got ${actualType}`);
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
