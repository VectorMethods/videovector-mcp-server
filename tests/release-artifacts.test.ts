import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareBundles,
  ReleaseArtifactError,
  mcpProjection,
  npmExpected,
  prepareNpmExecutable,
  stableJson,
  validateProjectMetadata,
  verifyBundle,
  verifyMcpVersion,
  verifyNpmVersion,
} from '../scripts/release-artifacts.mjs';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('npm executable preparation', () => {
  it('preserves clean TypeScript output bytes while adding the packaged CLI mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-npm-executable.'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'dist'));
    const executable = path.join(root, 'dist', 'index.js');
    const bytes = Buffer.from('#!/usr/bin/env node\nconsole.log("ready");\n');
    fs.writeFileSync(executable, bytes, { mode: 0o644 });
    expect(fs.statSync(executable).mode & 0o777).toBe(0o644);

    prepareNpmExecutable(root);

    expect(fs.readFileSync(executable)).toEqual(bytes);
    expect(fs.statSync(executable).mode & 0o777).toBe(0o755);
  });

  it('rejects a linked executable without changing the link target mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-npm-executable.'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'dist'));
    const target = path.join(root, 'other.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n', { mode: 0o644 });
    fs.symlinkSync(target, path.join(root, 'dist', 'index.js'));

    expect(() => prepareNpmExecutable(root)).toThrow('must be a regular file');
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });
});

function packageEnvironment(): Array<Record<string, boolean | string>> {
  return [
    {
      name: 'VIDEOVECTOR_API_KEY',
      description: 'VideoVector production API key.',
      format: 'string',
      isRequired: true,
      isSecret: true,
    },
    {
      name: 'VIDEOVECTOR_BASE_URL',
      description: 'VideoVector API base URL.',
      format: 'string',
      default: 'https://api.vectormethods.com/api/v2',
    },
    {
      name: 'VIDEOVECTOR_TIMEOUT',
      description: 'Per-request timeout in milliseconds.',
      format: 'number',
      default: '90000',
    },
    {
      name: 'VIDEOVECTOR_MAX_RETRIES',
      description: 'Maximum retry count for retryable API failures.',
      format: 'number',
      default: '3',
    },
  ];
}

function fakeBundle(): string {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-test.'));
  temporaryDirectories.push(bundle);
  const npmDirectory = path.join(bundle, 'npm');
  const mcpDirectory = path.join(bundle, 'mcp');
  fs.mkdirSync(npmDirectory);
  fs.mkdirSync(mcpDirectory);
  const packageJson = {
    name: '@vectormethods/videovector-mcp-server',
    version: '2.0.2',
    mcpName: 'io.github.VectorMethods/videovector-mcp-server',
    bin: { 'videovector-mcp': 'dist/index.js' },
    engines: { node: '>=18.0.0' },
    packageManager: 'npm@11.15.0',
  };
  const server = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: packageJson.mcpName,
    title: 'VideoVector MCP Server',
    description: 'Description.',
    version: packageJson.version,
    packages: [{
      registryType: 'npm',
      identifier: packageJson.name,
      version: packageJson.version,
      environmentVariables: packageEnvironment(),
      transport: { type: 'stdio' },
    }],
  };
  const tarball = path.join(npmDirectory, 'vectormethods-videovector-mcp-server-2.0.2.tgz');
  const npmLayout = path.join(bundle, 'npm-layout');
  fs.mkdirSync(path.join(npmLayout, 'package/dist'), { recursive: true });
  fs.writeFileSync(path.join(npmLayout, 'package/package.json'), stableJson(packageJson));
  fs.writeFileSync(path.join(npmLayout, 'package/server.json'), stableJson(server));
  fs.writeFileSync(path.join(npmLayout, 'package/dist/index.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(npmLayout, 'package/dist/index.js'), 0o755);
  const npmTar = spawnSync('tar', ['-czf', tarball, '-C', npmLayout, 'package'], { encoding: 'utf8' });
  if (npmTar.status !== 0) throw new Error(npmTar.stderr);
  fs.rmSync(npmLayout, { force: true, recursive: true });
  const serverPath = path.join(mcpDirectory, 'server.json');
  fs.writeFileSync(serverPath, stableJson(server));
  const registryMetadata = {
    schema_version: '2.0.0',
    npm: npmExpected({ packageJson, tarball, tarballBytes: fs.readFileSync(tarball) }),
    mcp_registry: {
      server: mcpProjection(server),
      server_json_sha256: sha256(fs.readFileSync(serverPath)),
    },
  };
  const registryPath = path.join(bundle, 'registry-metadata.json');
  fs.writeFileSync(registryPath, stableJson(registryMetadata));
  const descriptor = (target: string, artifactPath: string, kind: string) => ({
    kind, path: artifactPath, sha256: sha256(fs.readFileSync(target)), size: fs.statSync(target).size,
  });
  fs.writeFileSync(path.join(bundle, 'release-manifest.json'), stableJson({
    schema_version: '2.0.0',
    package: { name: packageJson.name, version: packageJson.version },
    repository: 'VectorMethods/videovector-mcp-server',
    source_sha: 'a'.repeat(40),
    tag: 'videovector-mcp-v2.0.2',
    tag_object_sha: 'c'.repeat(40),
    tag_commit_sha: 'a'.repeat(40),
    source_date_epoch: 1_700_000_000,
    release_body_sha256: 'b'.repeat(64),
    artifacts: [
      descriptor(tarball, `npm/${path.basename(tarball)}`, 'npm-tarball'),
      descriptor(serverPath, 'mcp/server.json', 'mcp-registry-metadata'),
    ],
    image_digest: null,
    registry_metadata_path: 'registry-metadata.json',
    registry_metadata_sha256: sha256(fs.readFileSync(registryPath)),
    tool_versions: { node: '24.14.0', npm: '11.15.0' },
  }));
  return bundle;
}

function git(root: string, ...arguments_: string[]): string {
  const result = spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

function releaseGuardFixture(): {
  environment: NodeJS.ProcessEnv;
  movingMainSha: string;
  releaseSha: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-guard.'));
  temporaryDirectories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'VectorMethods Engineering');
  git(root, 'config', 'user.email', 'opensource@vectormethods.com');
  fs.writeFileSync(path.join(root, 'release.txt'), 'release\n');
  git(root, 'add', 'release.txt');
  git(root, 'commit', '-m', 'release');
  const releaseSha = git(root, 'rev-parse', 'HEAD');
  const releaseTag = 'videovector-mcp-v2.3.4';
  git(root, 'tag', '-a', releaseTag, '-m', 'release');
  const tagObjectSha = git(root, 'rev-parse', `refs/tags/${releaseTag}`);
  const releaseBodySha256 = 'b'.repeat(64);
  const repository = 'VectorMethods/videovector-mcp-server';
  const operationNonce = createHash('sha256')
    .update(`${JSON.stringify({
      body_sha256: releaseBodySha256,
      repo: repository,
      tag: releaseTag,
      tag_commit_sha: releaseSha,
      tag_object_sha: tagObjectSha,
    })}\n`)
    .digest('hex');
  fs.writeFileSync(path.join(root, 'release.txt'), 'main advanced\n');
  git(root, 'commit', '-am', 'advance main');
  const movingMainSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--detach', releaseSha);

  return {
    environment: {
      ...process.env,
      EXPECTED_TARGET_SHA: releaseSha,
      EXPECTED_TAG_OBJECT_SHA: tagObjectSha,
      DRAFT_RELEASE_ID: '42',
      GITHUB_ACTOR: 'vectormethods-public-bot[bot]',
      GITHUB_OUTPUT: path.join(root, 'github-output'),
      GITHUB_REF: `refs/tags/${releaseTag}`,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: releaseSha,
      OPERATION_NONCE: operationNonce,
      RELEASE_BODY_SHA256: releaseBodySha256,
      RELEASE_TAG: releaseTag,
      RELEASE_TAG_PREFIX: 'videovector-mcp-v',
    },
    movingMainSha,
    releaseSha,
    root,
  };
}

function runReleaseGuard(
  root: string,
  environment: NodeJS.ProcessEnv
): ReturnType<typeof spawnSync> {
  return spawnSync(
    'bash',
    [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'scripts',
        'validate_release_request.sh'
      ),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: environment,
    }
  );
}

describe('release registry verification', () => {
  it('binds npm metadata and the independently tested Docker default to stdio', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    const serverJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8')
    );
    expect(() => validateProjectMetadata(packageJson, serverJson)).not.toThrow();

    const dockerfile = fs.readFileSync(
      path.join(sourceRoot, 'Dockerfile'),
      'utf8'
    );
    const defaults = [...dockerfile.matchAll(
      /^\s*ENV\s+MCP_TRANSPORT_MODE(?:=|\s+)(\S+)\s*$/gm
    )].map((match) => match[1]);
    expect(defaults).toEqual(['stdio']);
    expect(packageJson.engines).toEqual({ node: '>=18.0.0' });
    expect(packageJson.packageManager).toBe('npm@11.15.0');
    expect(dockerfile.match(
      /FROM node:24\.14\.0-bookworm-slim@sha256:[0-9a-f]{64}/g
    )).toHaveLength(2);
    expect(dockerfile).toContain('npm@11.15.0');
    expect(dockerfile).toContain('ENTRYPOINT []');
  });

  it('fails closed when package credentials or hosted auth metadata drift', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    const serverJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8')
    );
    const missingCredential = structuredClone(serverJson);
    missingCredential.packages[0].environmentVariables = [];
    expect(() => validateProjectMetadata(packageJson, missingCredential)).toThrow(
      'server.json npm environment metadata is inconsistent'
    );

    const unauthenticatedRemote = structuredClone(serverJson);
    unauthenticatedRemote.remotes = [
      {
        type: 'streamable-http',
        url: 'https://api.vectormethods.com/mcp',
      },
    ];
    expect(() => validateProjectMetadata(packageJson, unauthenticatedRemote)).toThrow(
      'hosted remotes require a separate authenticated contract'
    );
  });

  it('enforces the pinned official schema and canonical package surface', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    const serverJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8')
    );

    const longDescription = structuredClone(serverJson);
    longDescription.description = 'x'.repeat(101);
    expect(() => validateProjectMetadata(packageJson, longDescription)).toThrow(
      'violates the pinned MCP schema'
    );

    const invalidWebsite = structuredClone(serverJson);
    invalidWebsite.websiteUrl = 'not a URL';
    expect(() => validateProjectMetadata(packageJson, invalidWebsite)).toThrow(
      'violates the pinned MCP schema'
    );

    const invalidIcon = structuredClone(serverJson);
    invalidIcon.icons = [{
      src: 'https://vectormethods.com/icon.png',
      mimeType: 'text/html',
    }];
    expect(() => validateProjectMetadata(packageJson, invalidIcon)).toThrow(
      'violates the pinned MCP schema'
    );

    const runtimeArguments = structuredClone(serverJson);
    runtimeArguments.packages[0].packageArguments = [];
    expect(() => validateProjectMetadata(packageJson, runtimeArguments)).toThrow(
      'server.json npm package contains non-canonical fields'
    );
  });

  it('compares every server-authored registry field on replay', () => {
    const serverJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8')
    );
    const expected = { server: mcpProjection(serverJson) };
    const candidates = [
      (() => {
        const candidate = structuredClone(serverJson);
        delete candidate.$schema;
        return candidate;
      })(),
      {
        ...structuredClone(serverJson),
        repository: {
          source: 'github',
          url: 'https://github.com/VectorMethods/another-repository',
        },
      },
      (() => {
        const candidate = structuredClone(serverJson);
        candidate.packages[0].packageArguments = [];
        return candidate;
      })(),
      {
        ...structuredClone(serverJson),
        remotes: [{
          type: 'streamable-http',
          url: 'https://api.vectormethods.com/mcp',
        }],
      },
    ];
    for (const candidate of candidates) {
      expect(() => verifyMcpVersion(expected, { server: candidate })).toThrow(
        'MCP Registry version metadata differs'
      );
    }
  });

  it('checks out the guarded source SHA in every privileged downstream job', () => {
    const workflow = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '.github',
        'workflows',
        'release.yml'
      ),
      'utf8'
    );

    expect(
      workflow.match(
        /ref: refs\/tags\/\$\{\{ inputs\.release_tag \}\}/g
      )
    ).toHaveLength(1);
    expect(
      workflow.match(/ref: \$\{\{ needs\.guard\.outputs\.source_sha \}\}/g)
    ).toHaveLength(4);
    expect(workflow.match(/npm ci --ignore-scripts/g)).toHaveLength(5);
    expect(
      workflow.match(/bash scripts\/install_pinned_npm\.sh/g)
    ).toHaveLength(6);
    expect(workflow).toMatch(
      /expected_target_sha:\s+description: "Exact commit SHA peeled from the immutable bot-created release tag"\s+required: true\s+type: string/
    );
    expect(workflow).toMatch(
      /expected_tag_object_sha:\s+description: "Exact annotated Git tag object SHA created by vectormethods-public-bot"\s+required: true\s+type: string/
    );
    expect(workflow).toContain(
      'EXPECTED_TARGET_SHA: ${{ inputs.expected_target_sha }}'
    );
    expect(workflow).toContain(
      'EXPECTED_TAG_OBJECT_SHA: ${{ inputs.expected_tag_object_sha }}'
    );
    expect(workflow).toContain(
      'OPERATION_NONCE: ${{ inputs.operation_nonce }}'
    );
    expect(workflow).toContain(
      'run-name: Release ${{ inputs.release_tag }} [${{ inputs.operation_nonce }}]'
    );
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).not.toContain('--tag-sha');
    expect(
      workflow.match(/bash scripts\/validate_release_request\.sh/g)
    ).toHaveLength(1);
    expect(workflow).not.toContain(
      'git fetch --no-tags origin +refs/heads/main'
    );
    expect(workflow).not.toContain('refs/remotes/origin/main');
    expect(workflow).not.toContain('registry-url:');
    expect(workflow).toContain('node-version: "24.14.0"');
    expect(workflow).not.toContain('node-version: "20.');
    expect(workflow).toContain('python-version: "3.11.13"');
    expect(workflow).not.toContain('docker/setup-qemu-action@');
    expect(workflow).not.toContain('tonistiigi/binfmt');
    expect(workflow).not.toContain('NPM_BOOTSTRAP_TOKEN');
  });

  it('peels the immutable tag without requiring moving main', () => {
    const { environment, movingMainSha, releaseSha, root } =
      releaseGuardFixture();

    expect(movingMainSha).not.toBe(releaseSha);
    const result = runReleaseGuard(root, environment);

    expect(result.status).toBe(0);
    const output = fs.readFileSync(environment.GITHUB_OUTPUT!, 'utf8');
    expect(output).toContain(`source_sha=${releaseSha}\n`);
    expect(output).toContain(
      `tag_object_sha=${environment.EXPECTED_TAG_OBJECT_SHA}\n`
    );
    expect(output).toContain('version=2.3.4\n');
  });

  it.each([
    'A'.repeat(40),
    'a'.repeat(39),
    'a'.repeat(41),
    'not-a-commit',
  ])('rejects malformed expected target SHA %s', (expectedTargetSha) => {
    const { environment, root } = releaseGuardFixture();
    environment.EXPECTED_TARGET_SHA = expectedTargetSha;

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'expected_target_sha must be a full lowercase 40-character Git commit SHA'
    );
  });

  it('rejects a well-formed nonce for a different release operation', () => {
    const { environment, root } = releaseGuardFixture();
    environment.OPERATION_NONCE = 'a'.repeat(64);

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'operation_nonce does not match the canonical release operation'
    );
  });

  it.each([
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    'not-a-digest',
  ])('rejects malformed operation nonce %s', (operationNonce) => {
    const { environment, root } = releaseGuardFixture();
    environment.OPERATION_NONCE = operationNonce;

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'operation_nonce must be a lowercase SHA-256 digest'
    );
  });

  it.each([
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3rc1',
    '1.2.3-01',
    '1.2.3+build',
    '1.2',
  ])('rejects noncanonical semantic version %s', (version) => {
    const { environment, releaseSha, root } = releaseGuardFixture();
    git(root, 'tag', '--delete', environment.RELEASE_TAG!);
    environment.RELEASE_TAG = `videovector-mcp-v${version}`;
    environment.GITHUB_REF = `refs/tags/${environment.RELEASE_TAG}`;
    git(
      root,
      'tag',
      '-a',
      environment.RELEASE_TAG,
      releaseSha,
      '-m',
      'release'
    );
    environment.EXPECTED_TAG_OBJECT_SHA = git(
      root,
      'rev-parse',
      environment.RELEASE_TAG
    );

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('valid release version');
  });

  it.each([
    'A'.repeat(40),
    'c'.repeat(39),
    'c'.repeat(41),
    'not-a-tag-object',
  ])('rejects malformed expected tag object SHA %s', (tagObjectSha) => {
    const { environment, root } = releaseGuardFixture();
    environment.EXPECTED_TAG_OBJECT_SHA = tagObjectSha;

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'expected_tag_object_sha must be a full lowercase 40-character Git tag object SHA'
    );
  });

  it('rejects a lightweight tag even when it peels to the expected commit', () => {
    const { environment, releaseSha, root } = releaseGuardFixture();
    git(root, 'tag', '--delete', environment.RELEASE_TAG!);
    git(root, 'tag', environment.RELEASE_TAG!, releaseSha);
    environment.EXPECTED_TAG_OBJECT_SHA = releaseSha;

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('annotated tag object');
  });

  it('rejects a valid but wrong expected target SHA', () => {
    const { environment, movingMainSha, root } = releaseGuardFixture();
    environment.EXPECTED_TARGET_SHA = movingMainSha;

    const result = runReleaseGuard(root, environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must match exactly');
  });

  it('accepts an npm version only when the published tarball bytes are identical', () => {
    const tarball = Buffer.from('immutable npm tarball');
    const expected = npmExpected({
      packageJson: {
        name: '@vectormethods/videovector-mcp-server',
        version: '2.0.2',
        mcpName: 'io.github.VectorMethods/videovector-mcp-server',
        bin: { 'videovector-mcp': 'dist/index.js' },
        engines: { node: '>=18.0.0' },
      },
      tarball: '/tmp/vectormethods-videovector-mcp-server-2.0.2.tgz',
      tarballBytes: tarball,
    });
    const metadata = {
      name: expected.name,
      version: expected.version,
      mcpName: expected.mcpName,
      bin: expected.bin,
      engines: expected.engines,
      dist: {
        tarball: 'https://registry.invalid/package.tgz',
        shasum: expected.tarball.sha1,
        integrity: `sha512-${expected.tarball.sha512}`,
      },
    };

    expect(() => verifyNpmVersion(expected, metadata, tarball)).not.toThrow();
    expect(() => verifyNpmVersion(
      expected,
      { ...metadata, deprecated: 'superseded' },
      tarball
    )).toThrow(/deprecated/);
    expect(() => verifyNpmVersion(
      expected,
      { ...metadata, deprecated: true },
      tarball
    )).toThrow(/deprecated/);
    expect(() =>
      verifyNpmVersion(expected, metadata, Buffer.from('different bytes'))
    ).toThrow(ReleaseArtifactError);
  });

  it('matches the actual Registry descriptor without rewriting provider metadata', () => {
    // Captured from the official 2.1.1 Registry version after successful publication.
    const record = JSON.parse(fs.readFileSync(
      path.join(sourceRoot, 'tests/fixtures/mcp-registry-2.1.1.json'), 'utf8'
    ));
    const descriptor = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8'));
    // This patch changes only the version and deletes redundant false fields.
    descriptor.version = record.server.version;
    descriptor.packages[0].version = record.server.version;
    expect(mcpProjection(descriptor)).toEqual(mcpProjection(record.server));
    expect(() => verifyMcpVersion({ server: mcpProjection(descriptor) }, record)).not.toThrow();
    for (const variable of descriptor.packages[0].environmentVariables.slice(1)) {
      expect(variable).not.toHaveProperty('isRequired');
      expect(variable).not.toHaveProperty('isSecret');
    }
  });

  it.each([
    ['isRequired', true],
    ['isSecret', true],
    ['isSecret', false],
    ['isRequired', 'false'],
    ['isSecret', null],
    ['default', 'different-default'],
    ['unknownSetting', true],
  ])('rejects noncanonical optional Registry field %s=%s', (field, value) => {
    const record = JSON.parse(fs.readFileSync(
      path.join(sourceRoot, 'tests/fixtures/mcp-registry-2.1.1.json'), 'utf8'
    ));
    const expected = { server: mcpProjection(record.server) };
    record.server.packages[0].environmentVariables[1][field as string] = value;
    expect(() => verifyMcpVersion(expected, record)).toThrow('MCP Registry version metadata differs');
  });

  it.each(['isRequired', 'isSecret'])('retains the API-key %s=true requirement', (field) => {
    const record = JSON.parse(fs.readFileSync(
      path.join(sourceRoot, 'tests/fixtures/mcp-registry-2.1.1.json'), 'utf8'
    ));
    const expected = { server: mcpProjection(record.server) };
    const missing = structuredClone(record);
    delete missing.server.packages[0].environmentVariables[0][field];
    expect(() => verifyMcpVersion(expected, missing)).toThrow('MCP Registry version metadata differs');
    record.server.packages[0].environmentVariables[0][field] = false;
    expect(() => verifyMcpVersion(expected, record)).toThrow('MCP Registry version metadata differs');
  });

  it('compares the complete publication-owned MCP Registry projection', () => {
    const server = {
      name: 'io.github.VectorMethods/videovector-mcp-server',
      title: 'VideoVector MCP Server',
      description: 'Description.',
      version: '2.0.2',
      packages: [
        {
          registryType: 'npm',
          identifier: '@vectormethods/videovector-mcp-server',
          version: '2.0.2',
          transport: { type: 'stdio' },
        },
      ],
    };
    const expected = { server: mcpProjection(server) };

    const activeMetadata = {
      server,
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'active' },
      },
    };
    expect(() => verifyMcpVersion(expected, activeMetadata)).not.toThrow();
    expect(() => verifyMcpVersion(expected, {
      ...activeMetadata,
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'deleted' },
      },
    })).toThrow(/not active/);
    expect(() =>
      verifyMcpVersion(expected, {
        ...activeMetadata,
        server: { ...server, description: 'Unexpected metadata.' },
      })
    ).toThrow(ReleaseArtifactError);
  });

  it('rejects retired container metadata and binds the registry file to the npm package', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    const server = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'server.json'), 'utf8'));
    server.packages.push({ registryType: 'oci', identifier: 'ghcr.io/example/retired:1.0.0', transport: { type: 'stdio' } });
    expect(() => validateProjectMetadata(packageJson, server)).toThrow(/exactly one npm/);

    const bundle = fakeBundle();
    const serverPath = path.join(bundle, 'mcp/server.json');
    const altered = JSON.parse(fs.readFileSync(serverPath, 'utf8'));
    altered.description = 'Changed registry-only metadata.';
    fs.writeFileSync(serverPath, stableJson(altered));
    const manifestPath = path.join(bundle, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const descriptor = manifest.artifacts.find((artifact: { kind: string }) => artifact.kind === 'mcp-registry-metadata');
    descriptor.sha256 = sha256(fs.readFileSync(serverPath));
    descriptor.size = fs.statSync(serverPath).size;
    fs.writeFileSync(manifestPath, stableJson(manifest));
    expect(() => verifyBundle(bundle)).toThrow(/Packaged server.json differs/);
  });

  it.each(['image_digest', 'ghcr', 'oci-artifact'])('rejects retired bundle field %s', (field) => {
    const bundle = fakeBundle();
    const manifestPath = path.join(bundle, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (field === 'image_digest') {
      manifest.image_digest = `sha256:${'a'.repeat(64)}`;
    } else if (field === 'oci-artifact') {
      manifest.artifacts.push({ kind: 'oci-image', path: 'image/container.tar', size: 1, sha256: 'a'.repeat(64) });
    } else {
      const metadataPath = path.join(bundle, 'registry-metadata.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      metadata.ghcr = { image: 'retired' };
      fs.writeFileSync(metadataPath, stableJson(metadata));
      manifest.registry_metadata_sha256 = sha256(fs.readFileSync(metadataPath));
    }
    fs.writeFileSync(manifestPath, stableJson(manifest));
    expect(() => verifyBundle(bundle)).toThrow(ReleaseArtifactError);
  });

  it('fails closed after an attested bundle artifact is modified', () => {
    const bundle = fakeBundle();
    const tarball = path.join(
      bundle,
      'npm/vectormethods-videovector-mcp-server-2.0.2.tgz'
    );

    expect(() => verifyBundle(bundle)).not.toThrow();
    fs.appendFileSync(tarball, 'tampered');
    expect(() => verifyBundle(bundle)).toThrow(ReleaseArtifactError);
  });

  it('recomputes registry metadata and rejects noncanonical artifact paths', () => {
    const metadataBundle = fakeBundle();
    const metadataPath = path.join(metadataBundle, 'registry-metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.npm.engines = { node: '>=99' };
    fs.writeFileSync(metadataPath, stableJson(metadata));
    const metadataManifestPath = path.join(
      metadataBundle,
      'release-manifest.json'
    );
    const metadataManifest = JSON.parse(
      fs.readFileSync(metadataManifestPath, 'utf8')
    );
    metadataManifest.registry_metadata_sha256 = sha256(
      fs.readFileSync(metadataPath)
    );
    fs.writeFileSync(metadataManifestPath, stableJson(metadataManifest));
    expect(() => verifyBundle(metadataBundle)).toThrow(
      /Registry metadata differs/
    );

    const pathBundle = fakeBundle();
    const pathManifestPath = path.join(pathBundle, 'release-manifest.json');
    const pathManifest = JSON.parse(fs.readFileSync(pathManifestPath, 'utf8'));
    pathManifest.artifacts[0].path = 'npm/../release-manifest.json';
    fs.writeFileSync(pathManifestPath, stableJson(pathManifest));
    expect(() => verifyBundle(pathBundle)).toThrow(
      /path or kind is invalid/
    );
  });

  it('requires independent release builds to be byte-for-byte identical', () => {
    const left = fakeBundle();
    const right = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-copy.'));
    temporaryDirectories.push(right);
    fs.cpSync(left, right, { recursive: true });

    expect(() => compareBundles(left, right)).not.toThrow();
    const manifestPath = path.join(right, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.source_date_epoch += 1;
    fs.writeFileSync(manifestPath, stableJson(manifest));

    expect(() => verifyBundle(right)).not.toThrow();
    expect(() => compareBundles(left, right)).toThrow(/not byte-for-byte/);
  });

  it('binds the requested annotated tag and exact package version', () => {
    const bundle = fakeBundle();
    expect(() => verifyBundle(bundle, {
      source_sha: 'a'.repeat(40),
      tag_commit_sha: 'a'.repeat(40),
      tag_object_sha: 'c'.repeat(40),
      tag: 'videovector-mcp-v2.0.2',
      release_body_sha256: 'b'.repeat(64),
    })).not.toThrow();
    expect(() => verifyBundle(bundle, {
      tag_object_sha: 'd'.repeat(40),
    })).toThrow(/tag_object_sha does not match/);

    const manifestPath = path.join(bundle, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.tag = 'videovector-mcp-v2.0.3';
    fs.writeFileSync(manifestPath, stableJson(manifest));
    expect(() => verifyBundle(bundle)).toThrow(/tag and package identity/);

    manifest.tag = 'videovector-mcp-v2.0.2';
    manifest.tag_sha = manifest.source_sha;
    fs.writeFileSync(manifestPath, stableJson(manifest));
    expect(() => verifyBundle(bundle)).toThrow(/non-canonical fields/);
  });

});
