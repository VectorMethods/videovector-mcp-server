import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS,getToolDefinitions,getToolAvailability } from '../src/tools/definitions.js';
describe('five-tool publication metadata',()=>{
 it('publishes valid titles, examples, closed argument objects and structured output schemas',()=>{for(const tool of TOOL_DEFINITIONS){expect(ToolSchema.safeParse(tool).success,tool.name).toBe(true);expect(tool.title).toMatch(/^[A-Z]/);expect(tool.inputSchema.additionalProperties).toBe(false);expect(tool.inputSchema.examples).toBeInstanceOf(Array);expect(tool.outputSchema?.type).toBe('object');expect(getToolAvailability(tool.name)).toEqual({transports:['stdio','streamable-http']});}});
 it('marks billed search and analysis writes as mutations; direct callbacks are open world',()=>{for(const tool of TOOL_DEFINITIONS){expect(tool.annotations?.readOnlyHint).toBe(['browse','get_analysis'].includes(tool.name));expect(tool.annotations?.openWorldHint).toBe(['analyze','import_media'].includes(tool.name));expect(tool.annotations?.destructiveHint).toBe(['analyze','import_media'].includes(tool.name));}});
 it('keeps public URL imports open world for OAuth without claiming callback side effects',()=>{
   const tools = getToolDefinitions({advertiseOAuth:true,includeLocalUpload:false});
   for (const tool of tools) {
     const importsMedia = ['analyze','import_media'].includes(tool.name);
     expect(tool.annotations?.openWorldHint,tool.name).toBe(importsMedia);
     expect(tool.annotations?.destructiveHint,tool.name).toBe(false);
     if (importsMedia) {
       expect(tool.inputSchema.properties?.source).toMatchObject({properties:{urls:expect.any(Object)}});
       expect(tool.inputSchema.properties?.webhook).toBeUndefined();
     }
   }
 });
 it('keeps native files at the root without attaching an embedded widget',()=>{for(const name of ['analyze','import_media']){const tool=TOOL_DEFINITIONS.find(t=>t.name===name)!;expect(tool._meta?.['openai/fileParams']).toEqual(['files']);expect(tool.inputSchema.properties?.files).toMatchObject({maxItems:8,items:{required:['download_url','file_id']}});}for(const tool of TOOL_DEFINITIONS){expect(tool._meta?.['openai/outputTemplate']).toBeUndefined();expect(tool._meta?.ui).toBeUndefined();expect(tool._meta?.['openai/widgetAccessible']).toBeUndefined();}});
});
