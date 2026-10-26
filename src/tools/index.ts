/** Public conversational six-tool dispatch. */
export { TOOL_NAMES, TOOL_DEFINITIONS, getToolDefinitions, getValidationToolDefinitions, getToolAvailability, getToolDefinition, getToolRequiredScope,
  type ToolTransport, type ToolAvailability, type ToolDefinitionOptions, type ToolName, type ToolRequiredScope } from './definitions.js';
export { isWorkflowTool, executeWorkflowTool, authorizeUploadFile, type WorkflowToolContext } from './workflow-handlers.js';
import type { VideoVectorClient } from '../client/index.js';
import type { McpToolResponse } from '../types/index.js';
import { executeWorkflowTool, type WorkflowToolContext } from './workflow-handlers.js';
import { formatError } from '../utils/helpers.js';
export type ToolHandlerResult = McpToolResponse;
export type ToolExecutionContext = WorkflowToolContext;
export async function executeTool(name: string, args: Record<string, unknown>, client: VideoVectorClient, context: ToolExecutionContext = {}): Promise<ToolHandlerResult> {
  try {
    return await executeWorkflowTool(name, args, client, context);
  } catch (error) { return formatError(error, { authenticationKind: context.authenticationKind }); }
}
