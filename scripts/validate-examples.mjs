#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = path.join(rootDir, 'examples');
const packageName = '@vectormethods/videovector-mcp-server';
const forbiddenPatterns = [
  /playground-api-stg/i,
  /sk_live_[A-Za-z0-9_-]{8,}/,
  /sk_test_[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function fail(message) {
  console.error(`[examples] ${message}`);
  process.exitCode = 1;
}

for (const entry of fs.readdirSync(examplesDir)) {
  if (!entry.endsWith('.json')) {
    continue;
  }

  const filePath = path.join(examplesDir, entry);
  const content = fs.readFileSync(filePath, 'utf8');

  try {
    JSON.parse(content);
  } catch (error) {
    fail(`${entry} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!content.includes(packageName) && !content.includes('localhost')) {
    fail(`${entry} does not reference ${packageName} or a local HTTP endpoint`);
  }

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) {
      fail(`${entry} contains forbidden placeholder, staging, or secret-like content`);
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('[examples] Example JSON files are valid and public-safe');
