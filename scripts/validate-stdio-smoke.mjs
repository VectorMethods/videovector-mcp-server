#!/usr/bin/env node
/** Validate exact artifact discovery against the generated public tool contract. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateStdioSmoke(response, contract) {
  const messages = response.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const initialized = messages.find((message) => message.id === 1);
  const listed = messages.find((message) => message.id === 2);
  assert.equal(initialized?.result?.serverInfo?.name, contract.server.name,
    'Artifact server name differs from the generated contract');
  assert.equal(initialized?.result?.serverInfo?.version, contract.server.version,
    'Artifact server version differs from the generated contract');
  assert(Array.isArray(listed?.result?.tools), 'Artifact did not return a tools list');
  const expected = contract.tools.filter((tool) =>
    tool.availability.transports.includes('stdio') && tool.availability.profiles.includes('full')
  ).map((tool) => tool.name).sort();
  const actual = listed.result.tools.map((tool) => tool.name).sort();
  assert(expected.length > 0, 'Generated contract has no stdio tools');
  assert.deepEqual(actual, expected, 'Artifact stdio tools differ from the generated contract');
  return { version: contract.server.version, toolCount: actual.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contract = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  validateStdioSmoke(process.env.RESPONSE ?? '', contract);
}
