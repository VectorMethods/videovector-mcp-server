/** Public six-tool dispatch and private Studio adapters. */
export { TOOL_NAMES, TOOL_DEFINITIONS, getToolDefinitions, getToolAvailability, getToolDefinition, getToolRequiredScope,
  type ToolTransport, type ToolAvailability, type ToolDefinitionOptions, type ToolName, type ToolRequiredScope } from './definitions.js';
export { isWorkflowTool, executeWorkflowTool, authorizeUploadFile, type WorkflowToolContext } from './workflow-handlers.js';
import type { VideoVectorClient } from '../client/index.js';
import type { McpToolResponse } from '../types/index.js';
import { executeWorkflowTool, type WorkflowToolContext } from './workflow-handlers.js';
import { RESULTS_APP_TOOLS } from './workflow-result-contract.js';
import { executeResultsAppTool } from './results-app-handlers.js';
import { formatError } from '../utils/helpers.js';
export type ToolHandlerResult = McpToolResponse;
export type ToolExecutionContext = WorkflowToolContext;
export async function executeTool(name: string, args: Record<string, unknown>, client: VideoVectorClient, context: ToolExecutionContext = {}): Promise<ToolHandlerResult> {
  try {
    if (RESULTS_APP_TOOLS.has(name)) return await executeResultsAppTool(name, args, client, context);
    return await executeWorkflowTool(name, args, client, context);
  } catch (error) { return formatError(error, { authenticationKind: context.authenticationKind }); }
}
