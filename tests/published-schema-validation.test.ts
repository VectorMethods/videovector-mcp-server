import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { getToolDefinitions } from '../src/tools/definitions.js';

const transports = [
  { name: 'direct stdio', options: { includeLocalUpload: true } },
  { name: 'direct HTTP', options: { includeLocalUpload: false } },
  { name: 'OAuth HTTP', options: { advertiseOAuth: true, includeLocalUpload: false } },
];
const catalogs = transports.flatMap(({ name, options }) => [false, true].map(includeAppTools => ({
  name: `${name}, app helpers ${includeAppTools ? 'included' : 'excluded'}`,
  options: { ...options, includeAppTools },
})));

function schemaValidator() {
  // The SDK default disables schema validation. Hosts may validate the schema
  // itself before accepting discovery, so keep it enabled here.
  return addFormats(new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateSchema: true }));
}

describe('published JSON Schema validity', () => {
  it.each(catalogs)('compiles every input and output schema for $name', ({ options }) => {
    const ajv = schemaValidator();
    for (const tool of getToolDefinitions(options)) {
      for (const field of ['inputSchema', 'outputSchema'] as const) {
        const schema = tool[field];
        if (schema !== undefined) {
          expect(() => ajv.compile(schema), `${tool.name}.${field}`).not.toThrow();
        }
      }
    }
  });

  it('retains the direct cloud constraint while accepting OAuth existing-media sources', () => {
    const ajv = schemaValidator();
    const direct = getToolDefinitions({ includeLocalUpload: false }).find(tool => tool.name === 'analyze')!;
    const validateDirect = ajv.compile(direct.inputSchema);
    expect(validateDirect({ instruction: 'Summarize', source: { connector_id: 'connector_123', prefix: 'clips/' } })).toBe(true);
    expect(validateDirect({ instruction: 'Summarize', source: { video_ids: ['video_123'], prefix: 'clips/' } })).toBe(false);

    const oauth = getToolDefinitions({ advertiseOAuth: true, includeLocalUpload: false }).find(tool => tool.name === 'analyze')!;
    const validateOAuth = ajv.compile(oauth.inputSchema);
    expect(validateOAuth({ instruction: 'Summarize', source: { video_ids: ['video_123'] } })).toBe(true);
    expect(validateOAuth({ instruction: 'Summarize', source: { connector_id: 'connector_123' } })).toBe(false);
    const oauthImport = getToolDefinitions({ advertiseOAuth: true, includeLocalUpload: false }).find(tool => tool.name === 'import_media')!;
    expect(oauthImport.inputSchema.properties).not.toHaveProperty('source');
  });
});
