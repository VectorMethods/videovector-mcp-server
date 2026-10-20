import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStdioSmoke } from '../scripts/validate-stdio-smoke.mjs';
import { RESULTS_APP_DEFINITIONS } from '../src/tools/workflow-result-contract.js';

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

  it('requires the canonical app-only helpers alongside the public tool contract', () => {
    const appTools = [{ name: 'app_only' }];
    const names = ['list_indexes', 'upload_media', 'app_only'];
    expect(validateStdioSmoke(response(names), contract, appTools)).toEqual({
      version: '2.1.0', toolCount: 3,
    });
    expect(() => validateStdioSmoke(response(), contract, appTools)).toThrow(/stdio tools differ/);
    expect(() => validateStdioSmoke(response([...names, 'unexpected']), contract, appTools))
      .toThrow(/stdio tools differ/);
    expect(() => validateStdioSmoke(response([...names, 'app_only']), contract, appTools))
      .toThrow(/stdio tools differ/);
  });

  it.each([true, false])('validates oversized discovery through stdin (valid=%s)', (valid) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-release-test-'));
    try {
      const contractPath = path.join(directory, 'contract.json');
      fs.writeFileSync(contractPath, JSON.stringify(contract));
      const messages = response(valid ? undefined : ['list_indexes', 'wrong_same_count'])
        .split('\n').map((line) => JSON.parse(line));
      messages[1].result.tools.push(...RESULTS_APP_DEFINITIONS.map(({ name }) => ({ name })));
      messages[1].result.tools[0].description = 'x'.repeat(256 * 1024);
      const payload = messages.map((entry) => JSON.stringify(entry)).join('\n');
      const script = fileURLToPath(new URL('../scripts/validate-stdio-smoke.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [script, contractPath], {
        input: payload,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(valid ? 0 : 1);
      if (!valid) expect(result.stderr).toContain('Artifact stdio tools differ');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
