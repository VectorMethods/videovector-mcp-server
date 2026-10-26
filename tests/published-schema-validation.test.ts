import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { getToolDefinitions, getValidationToolDefinitions } from '../src/tools/definitions.js';

const transports = [
  { name: 'direct stdio', options: { includeLocalUpload: true } },
  { name: 'direct HTTP', options: { includeLocalUpload: false } },
  { name: 'OAuth HTTP', options: { advertiseOAuth: true, includeLocalUpload: false } },
];
const catalogs = transports.flatMap(({ name, options }) => [getToolDefinitions, getValidationToolDefinitions].map(catalog => ({
  name: `${name}, ${catalog === getToolDefinitions ? 'published' : 'strict'}`,
  options, catalog,
})));

function schemaValidator() {
  // The SDK default disables schema validation. Hosts may validate the schema
  // itself before accepting discovery, so keep it enabled here.
  return addFormats(new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateSchema: true }));
}

describe('published JSON Schema validity', () => {
  it.each(catalogs)('compiles every input and output schema for $name', ({ options, catalog }) => {
    const ajv = schemaValidator();
    for (const tool of catalog(options)) {
      for (const field of ['inputSchema', 'outputSchema'] as const) {
        const schema = tool[field];
        if (schema !== undefined) {
          expect(() => ajv.compile(schema), `${tool.name}.${field}`).not.toThrow();
          if (field === 'inputSchema') {
            const validate = ajv.compile(schema);
            for (const example of (schema.examples ?? []) as unknown[]) {
              expect(validate(example), `${tool.name} example: ${ajv.errorsText(validate.errors)}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('retains the direct cloud constraint while accepting OAuth existing-media sources', () => {
    const ajv = schemaValidator();
    const direct = getValidationToolDefinitions({ includeLocalUpload: false }).find(tool => tool.name === 'analyze')!;
    const validateDirect = ajv.compile(direct.inputSchema);
    expect(validateDirect({ instruction: 'Summarize', source: { connector_id: 'connector_123', prefix: 'clips/' } })).toBe(true);
    expect(validateDirect({ instruction: 'Summarize', source: { video_ids: ['video_123'], prefix: 'clips/' } })).toBe(false);

    const oauth = getValidationToolDefinitions({ advertiseOAuth: true, includeLocalUpload: false }).find(tool => tool.name === 'analyze')!;
    const validateOAuth = ajv.compile(oauth.inputSchema);
    expect(validateOAuth({ instruction: 'Summarize', source: { video_ids: ['video_123'] } })).toBe(true);
    expect(validateOAuth({ instruction: 'Summarize', source: { connector_id: 'connector_123' } })).toBe(false);
    const oauthImport = getToolDefinitions({ advertiseOAuth: true, includeLocalUpload: false }).find(tool => tool.name === 'import_media')!;
    expect(oauthImport.inputSchema.properties).not.toHaveProperty('source');
  });

  it.each(transports)('publishes typed fields without conditional record unions for $name', ({ options }) => {
    const strict = getValidationToolDefinitions(options);
    for (const tool of getToolDefinitions(options)) {
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else']) {
        expect(tool.inputSchema).not.toHaveProperty(keyword);
      }
      const canonical = strict.find(candidate => candidate.name === tool.name)!;
      expect(Object.keys(tool.inputSchema.properties!)).toEqual(Object.keys(canonical.inputSchema.properties!));
      expect(tool.inputSchema.examples).toEqual(canonical.inputSchema.examples);
      expect(tool.outputSchema).toEqual(canonical.outputSchema);
      if (tool.name === 'analyze' || tool.name === 'import_media') {
        expect(tool._meta?.['openai/fileParams']).toEqual(['files']);
        const files = tool.inputSchema.properties!.files as any;
        expect(files).toEqual(canonical.inputSchema.properties!.files);
        expect(Object.keys(files.items.properties)).toEqual(['download_url', 'file_id', 'mime_type', 'file_name']);
        expect(files.items.required).toEqual(['download_url', 'file_id']);
        expect(Object.values(files.items.properties).every((field: any) => field.type === 'string')).toBe(true);
      }
    }
  });

  it('retains structural cloud-provider configurations and typed filter alternatives', () => {
    const tools = getToolDefinitions({ includeLocalUpload: false });
    const analyze = tools.find(tool => tool.name === 'analyze')!;
    const source = analyze.inputSchema.properties!.source as any;
    expect(source).not.toHaveProperty('oneOf');
    const configurations = Object.fromEntries(source.properties.connector.oneOf.map((branch: any) => [
      branch.properties.provider.const, branch.properties.config,
    ]));
    expect(Object.keys(configurations.gcs.properties)).toEqual(['bucket', 'gcp_project_id', 'credentials_json']);
    expect(Object.keys(configurations.s3.properties)).toEqual(['bucket', 'region', 'aws_access_key_id', 'aws_secret_access_key']);
    expect(Object.keys(configurations.azure.properties)).toEqual(['storage_account', 'container', 'tenant_id', 'client_id', 'client_secret']);
    expect(configurations.gcs.properties.credentials_json).toMatchObject({ type: 'object', writeOnly: true });
    expect(configurations.s3.properties.aws_secret_access_key).toMatchObject({ type: 'string', writeOnly: true });

    const prompt = tools.find(tool => tool.name === 'save_prompt')!.inputSchema.properties!.definition as any;
    const variants = prompt.properties.selection_filter.properties.segment.properties.conditions.items.oneOf;
    expect(variants.map((branch: any) => branch.properties.operator.enum[0])).toContain('item_equals');
    const arrayEquals = variants.find((branch: any) => branch.properties.type.enum[0] === 'array'
      && branch.properties.operator.enum[0] === 'item_equals');
    expect(arrayEquals.properties.value.oneOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'boolean' }]);
  });

  it('keeps selector constraints in the canonical validator without duplicating them in presentation', () => {
    const options = { advertiseOAuth: true, includeLocalUpload: false };
    const canonical = getValidationToolDefinitions(options).find(tool => tool.name === 'analyze')!;
    const published = getToolDefinitions(options).find(tool => tool.name === 'analyze')!;
    const ajv = schemaValidator();
    const strict = ajv.compile(canonical.inputSchema);
    const presentation = ajv.compile(published.inputSchema);
    const conflicting = { instruction: 'Describe', prompt_id: 'prompt_123', source: { video_ids: ['video_123'] } };
    expect(presentation(conflicting)).toBe(true);
    expect(strict(conflicting)).toBe(false);
    // Internal stdio intake intentionally acquires its grant after Node has
    // authorized the local files and removed paths from the backend request.
    const internal = getValidationToolDefinitions({ includeLocalUpload: true }).find(tool => tool.name === 'analyze')!;
    expect(ajv.compile(internal.inputSchema)({ instruction: 'Describe' })).toBe(true);
  });
});
