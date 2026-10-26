import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStdioSmoke } from '../scripts/validate-stdio-smoke.mjs';

const names = ['analyze', 'get_analysis', 'search', 'import_media', 'save_prompt', 'browse'];
const contract = {
  server: { name: 'videovector', version: '6.0.0' },
  tools: [
    ...names.map(name => ({ name, availability: { transports: ['stdio', 'streamable-http'] } })),
    { name: 'http_only', availability: { transports: ['streamable-http'] } },
  ],
};
function response(toolNames = [...names].reverse(), version = contract.server.version) {
  return [
    { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'videovector', version } } },
    { jsonrpc: '2.0', id: 2, result: { tools: toolNames.map(name => ({ name })) } },
  ].map(entry => JSON.stringify(entry)).join('\n');
}

describe('release artifact stdio discovery', () => {
  it('compares the complete six-tool catalog without profiles or list-order assumptions', () => {
    expect(validateStdioSmoke(response(), contract)).toEqual({ version: '6.0.0', toolCount: 6 });
  });
  it.each([
    { toolNames: names.slice(1) },
    { toolNames: [...names, 'http_only'] },
    { toolNames: [...names, 'upload_media'] },
    { toolNames: [...names.slice(1), names[1]] },
    { toolNames: [...names.slice(1), 'wrong_same_count'] },
  ])('rejects missing, extra, duplicate, replaced or retired tools: $toolNames', ({ toolNames }) => {
    expect(() => validateStdioSmoke(response(toolNames), contract)).toThrow(/stdio tools differ/);
  });
  it('rejects retired app-only helpers outside the public six-tool contract', () => {
    expect(() => validateStdioSmoke(response([...names, 'read_analysis']), contract)).toThrow(/stdio tools differ/);
  });
  it.each([true, false])('validates oversized discovery through stdin (valid=%s)', valid => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-release-test-'));
    try {
      const contractPath = path.join(directory, 'contract.json');
      fs.writeFileSync(contractPath, JSON.stringify(contract));
      const messages = response(valid ? undefined : [...names.slice(1), 'wrong_same_count'])
        .split('\n').map(line => JSON.parse(line));
      messages[1].result.tools[0].description = 'x'.repeat(256 * 1024);
      const script = fileURLToPath(new URL('../scripts/validate-stdio-smoke.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [script, contractPath], {
        input: messages.map(entry => JSON.stringify(entry)).join('\n'), encoding: 'utf8', timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(valid ? 0 : 1);
      if (!valid) expect(result.stderr).toContain('Artifact stdio tools differ');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('rejects an artifact from a different version', () => {
    expect(() => validateStdioSmoke(response(undefined, '4.0.1'), contract)).toThrow(/version differs/);
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
