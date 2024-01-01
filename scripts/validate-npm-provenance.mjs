#!/usr/bin/env node

/** Exercise the exact npm publisher's provenance generator without signing or I/O. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { npmPublisherEnvironment } from './release-publication.mjs';

const NPM_VERSION = '11.21.0';
// From the checksum-pinned npm archive installed by install_pinned_npm.sh.
const PROVENANCE_SHA256 = 'ee9b1bc8e3f636fbaf5138a3e183ce3c6d42bb5dd57ab004578e534dd08da46b';

export const OFFLINE_ENVIRONMENT = Object.freeze({
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'offline-placeholder-not-a-token',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://offline.invalid/id-token',
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/tags/videovector-mcp-v0.0.0-offline',
  GITHUB_REPOSITORY: 'VectorMethods/videovector-mcp-server',
  GITHUB_REPOSITORY_ID: '123456789',
  GITHUB_REPOSITORY_OWNER_ID: '987654321',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_RUN_ID: '456789123',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  GITHUB_WORKFLOW: 'Release',
  GITHUB_WORKFLOW_REF: 'VectorMethods/videovector-mcp-server/.github/workflows/release.yml@refs/tags/videovector-mcp-v0.0.0-offline',
  GITHUB_WORKFLOW_SHA: '0123456789abcdef0123456789abcdef01234567',
  RUNNER_ENVIRONMENT: 'github-hosted',
});

export const OFFLINE_SUBJECT = Object.freeze({
  name: 'pkg:npm/%40vectormethods/videovector-mcp-server@0.0.0-offline',
  digest: Object.freeze({ sha512: 'ab'.repeat(64) }),
});

export function assertCompleteNpmProvenance(payload) {
  const env = OFFLINE_ENVIRONMENT;
  // Compare against the original identity, never the filtered environment: a
  // dropped field must fail rather than change the expected statement too.
  assert.deepEqual(payload, {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [OFFLINE_SUBJECT],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: env.GITHUB_REF,
            repository: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
            path: '.github/workflows/release.yml',
          },
        },
        internalParameters: {
          github: {
            event_name: env.GITHUB_EVENT_NAME,
            repository_id: env.GITHUB_REPOSITORY_ID,
            repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
          },
        },
        resolvedDependencies: [{
          uri: `git+${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}@${env.GITHUB_REF}`,
          digest: { gitCommit: env.GITHUB_SHA },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: {
          invocationId: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
        },
      },
    },
  }, 'npm provenance must retain the complete publisher identity');
}

export function readPinnedNpmProvenance(npmRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'npm', 'Expected the npm CLI package');
  assert.equal(metadata.version, NPM_VERSION, 'Expected the pinned npm publisher version');
  const filename = path.join(npmRoot, 'node_modules/libnpmpublish/lib/provenance.js');
  const source = fs.readFileSync(filename, 'utf8');
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    PROVENANCE_SHA256,
    'npm provenance implementation differs from the reviewed pinned archive'
  );
  return { filename, source };
}

export async function validateNpmProvenance(npmRoot) {
  const { filename, source } = readPinnedNpmProvenance(npmRoot);
  const environment = npmPublisherEnvironment(OFFLINE_ENVIRONMENT);
  let attestations = 0;
  let payload;
  const module = { exports: {} };
  const denyIo = () => { throw new Error('Offline provenance validation forbids I/O'); };
  // The only executable input is the hash-pinned npm module. Neither the real
  // process environment nor network, credentials, signing, or filesystem APIs
  // are exposed. The actual npm generator still constructs the full statement.
  vm.runInNewContext(source, {
    Buffer,
    module,
    process: { env: environment },
    require(name) {
      if (name === 'ci-info') return { GITHUB_ACTIONS: true };
      if (name === 'node:fs/promises') return { readFile: denyIo };
      if (name === 'sigstore') {
        return {
          async attest(bytes, type, options) {
            attestations += 1;
            assert.equal(type, 'application/vnd.in-toto+json');
            assert.deepEqual(options, {});
            payload = JSON.parse(bytes.toString('utf8'));
            return { offline: true };
          },
          verify: denyIo,
        };
      }
      throw new Error(`Unexpected dependency in pinned npm provenance module: ${name}`);
    },
  }, { filename, timeout: 1_000 });
  await module.exports.generateProvenance([OFFLINE_SUBJECT], {});
  assert.equal(attestations, 1, 'npm must emit exactly one provenance statement');
  assertCompleteNpmProvenance(payload);
  return { npm: NPM_VERSION, provenanceSha256: PROVENANCE_SHA256, status: 'passed' };
}

const isDirectExecution = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--npm-root' || !args[1]) {
    console.error('Usage: node scripts/validate-npm-provenance.mjs --npm-root PATH');
    process.exitCode = 1;
  } else {
    validateNpmProvenance(path.resolve(args[1]))
      .then((result) => console.log(`[npm provenance] ${JSON.stringify(result)}`))
      .catch((error) => {
        console.error(`[npm provenance] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
  }
}
