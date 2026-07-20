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
import { TOOL_DEFINITIONS } from './definitions.js';
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
              available_tools: TOOL_DEFINITIONS.map((tool) => tool.name),
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
