import { describe, expect, it } from 'vitest';

import {
  TOOL_DEFINITIONS,
  getToolDefinitions,
} from '../src/tools/definitions.js';

const OAUTH_PUBLICATION_UNSAFE_TOOLS = [
  'create_gcs_connector',
  'create_s3_connector',
  'create_azure_connector',
  'create_webhook',
  'get_export_download_url',
].sort();

describe('hosted OAuth tool metadata', () => {
  it('decorates only cloned hosted tools with empty-scope OAuth schemes', () => {
    const hosted = getToolDefinitions('full', false, { advertiseOAuth: true });
    expect(hosted.length).toBeGreaterThan(0);
    const hostedNames = hosted.map((tool) => tool.name);
    expect(hostedNames).toContain('upload_media');
    for (const unsafeTool of OAUTH_PUBLICATION_UNSAFE_TOOLS) {
      expect(hostedNames).not.toContain(unsafeTool);
    }
    for (const tool of hosted as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
      expect(tool._meta?.securitySchemes).toEqual(tool.securitySchemes);
    }

    const stdio = getToolDefinitions('full', true);
    expect(stdio.map((tool) => tool.name)).toContain('upload_media');
    for (const tool of stdio as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toBeUndefined();
      expect(tool._meta?.securitySchemes).toBeUndefined();
    }
    for (const tool of TOOL_DEFINITIONS as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toBeUndefined();
      expect(tool._meta?.securitySchemes).toBeUndefined();
    }

    const apiKeyHttpNames = getToolDefinitions('full', false).map((tool) => tool.name);
    expect(apiKeyHttpNames).toEqual(expect.arrayContaining(OAUTH_PUBLICATION_UNSAFE_TOOLS));
  });

  it('does not change tool-profile selection', () => {
    expect(
      getToolDefinitions('simple', false, { advertiseOAuth: true })
        .map((tool) => tool.name)
    ).toEqual(['find', 'upload_media', 'define_prompt', 'process_media', 'search_media', 'get_prompt_run_status', 'get_prompt_run_results', 'get_import_job', 'retry_import_job']);
  });
});
