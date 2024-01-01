import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStdioSmoke } from '../scripts/validate-stdio-smoke.mjs';

const contract = {
  server: { name: 'videovector', version: '2.1.0' },
  tools: [
    { name: 'upload_media', availability: { profiles: ['simple', 'full'], transports: ['stdio'] } },
    { name: 'list_indexes', availability: { profiles: ['full'], transports: ['stdio', 'streamable-http'] } },
    { name: 'http_only', availability: { profiles: ['full'], transports: ['streamable-http'] } },
  ],
};
function response(names = ['list_indexes', 'upload_media'], version = '2.1.0') {
  return [
    { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'videovector', version } } },
    { jsonrpc: '2.0', id: 2, result: { tools: names.map((name) => ({ name })) } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
}

describe('release artifact stdio discovery', () => {
  it('compares exact stdio tools independently of list order or historical counts', () => {
    expect(validateStdioSmoke(response(), contract)).toEqual({ version: '2.1.0', toolCount: 2 });
  });

  it.each([
    { names: ['list_indexes'] },
    { names: ['list_indexes', 'upload_media', 'http_only'] },
    { names: ['list_indexes', 'list_indexes'] },
    { names: ['list_indexes', 'wrong_same_count'] },
  ])('rejects missing, extra, duplicate, or replaced tools: $names', ({ names }) => {
    expect(() => validateStdioSmoke(response(names), contract)).toThrow(/stdio tools differ/);
  });

  it('rejects an artifact from a different version', () => {
    expect(() => validateStdioSmoke(response(undefined, '2.0.2'), contract)).toThrow(/version differs/);
  });

  it('rejects malformed or failed MCP discovery responses', () => {
    expect(() => validateStdioSmoke('not json', contract)).toThrow();
    expect(() => validateStdioSmoke('{"id":1,"error":{"code":-32603}}', contract)).toThrow();
  });
});


describe('checksum-pinned npm installer profiles', () => {
  it.each([{ args: ['latest'] }, { args: ['publisher', 'unexpected'] }])(
    'rejects unreviewed installer selections before downloads: $args',
    ({ args }) => {
      const script = fileURLToPath(new URL('../scripts/install_pinned_npm.sh', import.meta.url));
      const result = spawnSync('bash', [script, ...args], { encoding: 'utf8' });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('Usage: install_pinned_npm.sh [build|publisher]');
    }
  );
});
