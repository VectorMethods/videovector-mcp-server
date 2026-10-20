import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOL_DEFINITIONS, getToolDefinitions } from '../src/tools/definitions.js';

const STRUCTURED_CONTENT_TOOLS = [
  'find',
  'get_import_job',
  'retry_import_job',
  'upload_media',
  'define_prompt',
  'process_media',
  'search_media',
  'search_videos',
  'search_videos_by_image',
  'multimodal_search',
  'filter_videos',
  'list_indexes',
  'get_index',
  'get_video',
  'get_video_segments',
  'get_prompt_run_status',
  'get_prompt_run_results',
  'get_prompt_run_video_result',
  'get_export_status',
  'list_videos',
].sort();

const OPEN_WORLD_TOOLS = [
  'export_index_metadata',
  'export_prompt_run',
  'test_webhook',
].sort();

const DESTRUCTIVE_TOOLS = [
  'cancel_prompt_run',
  'retry_prompt_run_segment',
  'update_prompt',
  'cancel_import_job',
  'retry_import_job',
  'update_webhook',
  'test_webhook',
].sort();

describe('publication tool metadata', () => {
  it('publishes a human-readable title and a complete annotation record for every tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(ToolSchema.safeParse(tool).success, tool.name).toBe(true);
      expect(tool.title, tool.name).toMatch(/^[A-Z][A-Za-z0-9 ]+$/);
      expect(tool.title, tool.name).not.toContain('_');
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it('advertises output schemas exactly for handlers that emit structuredContent', () => {
    const toolsWithOutputSchema = TOOL_DEFINITIONS
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name)
      .sort();

    expect(toolsWithOutputSchema).toEqual(STRUCTURED_CONTENT_TOOLS);

    for (const tool of TOOL_DEFINITIONS.filter((item) => item.outputSchema !== undefined)) {
      const schema = tool.outputSchema as {
        type?: unknown;
        properties?: Record<string, unknown>;
        required?: unknown;
      };
      expect(schema.type, tool.name).toBe('object');
      expect(schema.properties, tool.name).toEqual(expect.any(Object));
      if (Array.isArray(schema.required)) {
        expect(schema.required, tool.name).toEqual(
          expect.arrayContaining(schema.required.filter((name) => name in (schema.properties ?? {})))
        );
        expect(
          schema.required.filter((name) => !(name in (schema.properties ?? {}))),
          `${tool.name} requires fields absent from properties`
        ).toEqual([]);
      }
    }
  });

  it('keeps private tenant operations closed-world and flags real external interactions', () => {
    const openWorldTools = TOOL_DEFINITIONS
      .filter((tool) => tool.annotations?.openWorldHint === true)
      .map((tool) => tool.name)
      .sort();

    expect(openWorldTools).toEqual(OPEN_WORLD_TOOLS);
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === 'search_media')?.annotations)
      .toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === 'process_media')?.annotations)
      .toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    for (const name of ['search_videos', 'search_videos_by_image', 'multimodal_search']) {
      expect(TOOL_DEFINITIONS.find((tool) => tool.name === name)?.annotations, name)
        .toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        });
    }
  });

  it('flags only operations that overwrite or irreversibly interrupt existing work', () => {
    const destructiveTools = TOOL_DEFINITIONS
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();

    expect(destructiveTools).toEqual(DESTRUCTIVE_TOOLS);
  });

  it('preserves titles, schemas, annotations, and empty OAuth scopes on hosted clones', () => {
    const baseByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    const hosted = getToolDefinitions('full', false, { advertiseOAuth: true });

    for (const hostedTool of hosted as Array<Record<string, any>>) {
      const base = baseByName.get(hostedTool.name);
      expect(base).toBeDefined();
      expect(hostedTool.title).toBe(base?.title);
      expect(hostedTool.outputSchema).toEqual(base?.outputSchema);
      expect(hostedTool.annotations).toEqual(base?.annotations);
      expect(hostedTool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
      expect(hostedTool._meta?.securitySchemes).toEqual(hostedTool.securitySchemes);
    }
  });
});
