/**
 * Tools exports
 */

export {
  TOOL_NAMES,
  TOOL_DEFINITIONS,
  SIMPLE_TOOL_DEFINITIONS,
  getToolDefinitions,
  getToolAvailability,
  getToolDefinition,
  getToolRequiredScope,
  type ToolProfile,
  type ToolTransport,
  type ToolAvailability,
  type ToolDefinitionOptions,
  type ToolName,
  type ToolRequiredScope,
} from './definitions.js';
export {
  SEARCH_HANDLERS,
  isSearchTool,
  executeSearchTool,
} from './search-handlers.js';
export {
  RESOURCE_HANDLERS,
  isResourceTool,
  executeResourceTool,
} from './resource-handlers.js';
export {
  WORKFLOW_HANDLERS,
  isWorkflowTool,
  executeWorkflowTool,
  authorizeUploadFile,
  type WorkflowToolContext,
} from './workflow-handlers.js';

// Combined handler execution
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { VideoVectorClient } from '../client/index.js';
import { TOOL_DEFINITIONS } from './definitions.js';
import { isSearchTool, executeSearchTool } from './search-handlers.js';
import { isResourceTool, executeResourceTool } from './resource-handlers.js';
import {
  isWorkflowTool,
  executeWorkflowTool,
  type WorkflowToolContext,
} from './workflow-handlers.js';
import { projectOAuthToolResult } from './oauth-result-projection.js';
import { formatError } from '../utils/helpers.js';
import { ToolInputError } from '../utils/helpers.js';
import { WORKFLOW_RESULT_TOOLS, WORKFLOW_DETAIL_TOOLS, RESULTS_APP_TOOLS } from './workflow-result-contract.js';
import { projectWorkflowResult, type ResultDetail } from './workflow-result-projection.js';
import { executeResultsAppTool } from './results-app-handlers.js';

export interface ToolHandlerResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  oauthAuthenticationFailure?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolExecutionContext extends WorkflowToolContext {
  authenticationKind?: 'api-key' | 'oauth';
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  client: VideoVectorClient,
  context: ToolExecutionContext = {}
): Promise<ToolHandlerResult> {
  try {
    const detail = args.detail === undefined ? 'summary' : args.detail;
    if (args.detail !== undefined && (!WORKFLOW_DETAIL_TOOLS.has(toolName) || typeof detail !== 'string' || !['summary', 'full'].includes(detail))) {
      throw new ToolInputError('detail must be summary or full and is supported only on workflow definition, processing, status, and result tools');
    }
    // Presentation is not part of the backend request or idempotency identity.
    const executionArgs = { ...args };
    delete executionArgs.detail;
    let result: ToolHandlerResult;
    if (RESULTS_APP_TOOLS.has(toolName)) {
      return await executeResultsAppTool(toolName, executionArgs, client);
    } else if (isWorkflowTool(toolName)) {
      result = await executeWorkflowTool(toolName, executionArgs, client, context);
    } else if (isSearchTool(toolName)) {
      result = await executeSearchTool(
        toolName,
        executionArgs,
        client,
        context.authenticationKind
      );
    } else if (isResourceTool(toolName)) {
      result = await executeResourceTool(
        toolName,
        executionArgs,
        client,
        context.authenticationKind
      );
    } else {
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: true,
                message: `Unknown tool: ${toolName}`,
                available_tools: TOOL_DEFINITIONS.map((tool) => tool.name),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    if (WORKFLOW_RESULT_TOOLS.has(toolName)) {
      const projected = await projectWorkflowResult(toolName, result, detail as ResultDetail, client);
      if (!projected.isError && ['get_prompt_run_results', 'search_media'].includes(toolName)) {
        const payload = projected.structuredContent!;
        const search = toolName === 'search_media';
        const page = search ? payload : payload[args.view === 'unfiltered' || payload.filtered === null ? 'unfiltered' : 'filtered'];
        const pagination = (page as { pagination?: { limit?: number } } | null)?.pagination;
        const viewRequest: Record<string, unknown> = { limit: args.limit ?? pagination?.limit ?? 10 };
        if (!search) {
          viewRequest.result_level = args.result_level ?? 'segment';
          viewRequest.view = args.view ?? 'both';
        }
        for (const key of search ? ['cursor'] : ['video_id', 'filtered_cursor', 'unfiltered_cursor']) {
          if (typeof args[key] === 'string') viewRequest[key] = args[key];
        }
        if (search) {
          if (typeof args.query === 'string') viewRequest.query = args.query;
          if (Array.isArray(args.filters)) viewRequest.filters = args.filters;
          if (Array.isArray(args.video_ids)) viewRequest.video_ids = args.video_ids;
        }
        // Keep the exact displayed scope/page in the widget channel, including
        // when the host restores a result without replaying its input event.
        projected._meta = { ...projected._meta, viewRequest };
      }
      return projected;
    }
    return context.authenticationKind === 'oauth'
      ? projectOAuthToolResult(toolName, result)
      : result;
  } catch (error) {
    return formatError(error, {
      authenticationKind: context.authenticationKind,
    });
  }
}
