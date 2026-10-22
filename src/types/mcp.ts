import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
export interface McpToolResponse {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  oauthAuthenticationFailure?: boolean;
  _meta?: Record<string, unknown>;
}
