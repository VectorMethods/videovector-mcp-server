#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(rootDir, 'artifacts');
const checkOnly = process.argv.includes('--check');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOrCheck(relativePath, value) {
  const target = path.join(rootDir, relativePath);
  const next = stableJson(value);

  if (checkOnly) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== next) {
      console.error(`[contract] ${relativePath} is stale. Run npm run generate:contract.`);
      process.exitCode = 1;
    }
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next);
}

const packageJson = readJson('package.json');
const definitionsUrl = pathToFileURL(path.join(rootDir, 'dist', 'tools', 'definitions.js'));
const { TOOL_DEFINITIONS, getToolCategory } = await import(definitionsUrl.href);

const contract = {
  schema_version: '1.0.0',
  server: {
    name: 'videovector',
    version: packageJson.version,
    protocol: 'mcp',
    primary_transport: 'stdio',
    supported_transports: ['stdio', 'streamable-http'],
  },
  package: {
    name: packageJson.name,
    version: packageJson.version,
    bin: 'videovector-mcp',
    npm_install_command: `npx -y ${packageJson.name}`,
  },
  api: {
    default_base_url: 'https://api.vectormethods.com/api/v2',
    env: {
      canonical: ['VIDEOVECTOR_API_KEY', 'VIDEOVECTOR_BASE_URL', 'VIDEOVECTOR_TIMEOUT', 'VIDEOVECTOR_MAX_RETRIES'],
      legacy_aliases: ['VIDEOSEARCH_API_KEY', 'VIDEOSEARCH_BASE_URL', 'VIDEOSEARCH_TIMEOUT', 'VIDEOSEARCH_MAX_RETRIES'],
    },
  },
  tools: TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    category: getToolCategory(tool.name),
  })),
};

const releaseMetadata = {
  schema_version: '1.0.0',
  package: {
    name: packageJson.name,
    version: packageJson.version,
    bin: 'videovector-mcp',
  },
  source: {
    repository: 'https://github.com/VectorMethods/videovector-mcp-server',
    contract_path: 'artifacts/tool-contract.json',
  },
  public_docs: {
    website_docs: 'https://vectormethods.com/docs/mcp',
    repository_docs: 'https://github.com/VectorMethods/videovector-mcp-server/tree/main/docs',
  },
};

const provenance = {
  schema_version: '1.0.0',
  package: {
    registry: 'npm',
    name: packageJson.name,
    tarball_command: 'npm pack --dry-run',
  },
  container: {
    registry: 'ghcr.io',
    image: 'ghcr.io/vectormethods/videovector-mcp-server',
    dockerfile: 'Dockerfile',
  },
  release_inputs: [
    'src/**',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'README.md',
    'docs/**',
    'examples/**',
    'artifacts/tool-contract.json',
  ],
};

fs.mkdirSync(artifactsDir, { recursive: true });
writeOrCheck('artifacts/tool-contract.json', contract);
writeOrCheck('artifacts/release-metadata.json', releaseMetadata);
writeOrCheck('artifacts/provenance.json', provenance);

if (process.exitCode) {
  process.exit(process.exitCode);
}

const verb = checkOnly ? 'Checked' : 'Wrote';
console.log(`[contract] ${verb} ${contract.tools.length} tools in artifacts/tool-contract.json`);
