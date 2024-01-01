/**
 * Tools exports
 */

export {
  TOOL_NAMES,
  TOOL_DEFINITIONS,
  getToolDefinition,
  getToolRequiredScope,
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

// Combined handler execution
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { VideoVectorClient } from '../client/index.js';
import { isSearchTool, executeSearchTool } from './search-handlers.js';
import { isResourceTool, executeResourceTool } from './resource-handlers.js';
import { formatError } from '../utils/helpers.js';

export interface ToolHandlerResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  try {
    if (isSearchTool(toolName)) {
      return await executeSearchTool(toolName, args, client);
    }

    if (isResourceTool(toolName)) {
      return await executeResourceTool(toolName, args, client);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              message: `Unknown tool: ${toolName}`,
              available_tools: [
                'search_videos',
                'search_videos_by_image',
                'multimodal_search',
                'filter_videos',
                'list_indexes',
                'get_index',
                'list_prompts',
                'get_video',
                'get_video_segments',
                'list_prompt_runs',
                'estimate_prompt_run',
                'execute_prompt',
                'get_prompt_run_status',
                'cancel_prompt_run',
                'get_prompt_run_results',
                'get_prompt_run_video_result',
                'get_prompt_run_failed_segments',
                'retry_prompt_run_segment',
                'get_prompt_run_segment_retry_status',
                'create_prompt',
                'get_prompt',
                'update_prompt',
                'test_prompt_schema',
                'get_prompt_usage',
                'create_gcs_connector',
                'create_s3_connector',
                'create_azure_connector',
                'list_connectors',
                'test_connector',
                'browse_connector_files',
                'create_import_job',
                'list_import_jobs',
                'get_import_job',
                'cancel_import_job',
                'create_index',
                'list_videos',
                'get_videos_status',
                'export_index_metadata',
                'export_prompt_run',
                'get_export_status',
                'create_webhook',
                'list_webhooks',
                'get_webhook',
                'update_webhook',
                'list_webhook_events',
                'test_webhook',
                'list_webhook_deliveries',
              ],
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  } catch (error) {
    return formatError(error);
  }
}
