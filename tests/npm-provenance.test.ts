import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCompleteNpmProvenance,
  readPinnedNpmProvenance,
} from '../scripts/validate-npm-provenance.mjs';

// Captured shape from npm 11.21's real generator. The CI/release check executes
// that hash-pinned implementation; these tests exercise its acceptance boundary.
function statement() {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: 'pkg:npm/%40vectormethods/videovector-mcp-server@0.0.0-offline',
      digest: { sha512: 'ab'.repeat(64) },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/tags/videovector-mcp-v0.0.0-offline',
            repository: 'https://github.com/VectorMethods/videovector-mcp-server',
            path: '.github/workflows/release.yml',
          },
        },
        internalParameters: {
          github: {
            event_name: 'workflow_dispatch',
            repository_id: '123456789',
            repository_owner_id: '987654321',
          } as Record<string, string>,
        },
        resolvedDependencies: [{
          uri: 'git+https://github.com/VectorMethods/videovector-mcp-server@refs/tags/videovector-mcp-v0.0.0-offline',
          digest: { gitCommit: '0123456789abcdef0123456789abcdef01234567' },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: {
          invocationId: 'https://github.com/VectorMethods/videovector-mcp-server/actions/runs/456789123/attempts/2',
        },
      },
    },
  };
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('exact npm provenance acceptance', () => {
  it('accepts the full GitHub-hosted release identity', () => {
    expect(() => assertCompleteNpmProvenance(statement())).not.toThrow();
  });

  it.each(['repository_id', 'repository_owner_id'])('rejects a filtered-out %s', (field) => {
    const payload = statement();
    delete payload.predicate.buildDefinition.internalParameters.github[field];
    expect(() => assertCompleteNpmProvenance(payload)).toThrow(/complete publisher identity/);
  });

  it('rejects the observed undefined runner builder', () => {
    const payload = statement();
    payload.predicate.runDetails.builder.id = 'https://github.com/actions/runner/undefined';
    expect(() => assertCompleteNpmProvenance(payload)).toThrow(/complete publisher identity/);
  });

  it.each(['workflow', 'source', 'run', 'subject'])('rejects changed %s identity', (field) => {
    const payload = statement();
    if (field === 'workflow') payload.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main';
    if (field === 'source') payload.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = 'f'.repeat(40);
    if (field === 'run') payload.predicate.runDetails.metadata.invocationId += '0';
    if (field === 'subject') payload.subject[0]!.digest.sha512 = 'cd'.repeat(64);
    expect(() => assertCompleteNpmProvenance(payload)).toThrow(/complete publisher identity/);
  });

  it('rejects an unreviewed npm version before loading its generator', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-provenance-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'npm', version: '11.15.0' }));
    expect(() => readPinnedNpmProvenance(directory)).toThrow(/pinned npm publisher version/);
  });

  it('rejects altered generator bytes even under the expected npm version', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-provenance-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'npm', version: '11.21.0' }));
    const library = path.join(directory, 'node_modules/libnpmpublish/lib');
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(path.join(library, 'provenance.js'), 'throw new Error("must not execute");');
    expect(() => readPinnedNpmProvenance(directory)).toThrow(/differs from the reviewed pinned archive/);
  });
});
