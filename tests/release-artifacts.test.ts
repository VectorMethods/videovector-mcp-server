import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReleaseArtifactError,
  main,
  mcpProjection,
  npmExpected,
  stableJson,
  verifyBundle,
  verifyImageVersion,
  verifyMcpVersion,
  verifyNpmVersion,
} from '../scripts/release-artifacts.mjs';

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

function fakeBundle(): string {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-test.'));
  temporaryDirectories.push(bundle);
  const npmDirectory = path.join(bundle, 'npm');
  const imageDirectory = path.join(bundle, 'image');
  const mcpDirectory = path.join(bundle, 'mcp');
  fs.mkdirSync(npmDirectory);
  fs.mkdirSync(imageDirectory);
  fs.mkdirSync(mcpDirectory);

  const packageJson = {
    name: '@vectormethods/videovector-mcp-server',
    version: '2.0.2',
    mcpName: 'io.github.VectorMethods/videovector-mcp-server',
    bin: { 'videovector-mcp': 'dist/index.js' },
    engines: { node: '>=18.0.0' },
  };
  const tarball = path.join(
    npmDirectory,
    'vectormethods-videovector-mcp-server-2.0.2.tgz'
  );
  const npmLayout = path.join(bundle, 'npm-layout');
  fs.mkdirSync(path.join(npmLayout, 'package'), { recursive: true });
  fs.writeFileSync(
    path.join(npmLayout, 'package/package.json'),
    stableJson(packageJson)
  );
  fs.writeFileSync(path.join(npmLayout, 'package/index.js'), '');
  const npmTar = spawnSync(
    'tar',
    ['-czf', tarball, '-C', npmLayout, 'package'],
    { encoding: 'utf8' }
  );
  if (npmTar.status !== 0) {
    throw new Error(npmTar.stderr);
  }
  fs.rmSync(npmLayout, { force: true, recursive: true });
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
      {
        registryType: 'oci',
        identifier: 'ghcr.io/vectormethods/videovector-mcp-server:2.0.2',
        transport: { type: 'stdio' },
      },
    ],
  };
  const serverPath = path.join(mcpDirectory, 'server.json');
  fs.writeFileSync(serverPath, stableJson(server));

  const labels = {
    'io.modelcontextprotocol.server.name':
      'io.github.VectorMethods/videovector-mcp-server',
    'org.opencontainers.image.revision': 'a'.repeat(40),
    'org.opencontainers.image.source':
      'https://github.com/VectorMethods/videovector-mcp-server',
    'org.opencontainers.image.version': '2.0.2',
  };
  const layout = path.join(bundle, 'oci-layout-source');
  fs.mkdirSync(path.join(layout, 'blobs', 'sha256'), { recursive: true });
  const config = Buffer.from(stableJson({ config: { Labels: labels } }));
  const configDigest = sha256(config);
  fs.writeFileSync(path.join(layout, 'blobs', 'sha256', configDigest), config);
  const imageManifest = Buffer.from(
    stableJson({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: `sha256:${configDigest}`,
        size: config.length,
      },
      layers: [],
    })
  );
  const imageDigest = sha256(imageManifest);
  fs.writeFileSync(
    path.join(layout, 'blobs', 'sha256', imageDigest),
    imageManifest
  );
  fs.writeFileSync(
    path.join(layout, 'index.json'),
    stableJson({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${imageDigest}`,
          size: imageManifest.length,
        },
      ],
    })
  );
  fs.writeFileSync(
    path.join(layout, 'oci-layout'),
    stableJson({ imageLayoutVersion: '1.0.0' })
  );
  const imageArchive = path.join(imageDirectory, 'videovector-mcp-server.oci.tar');
  const tar = spawnSync(
    'tar',
    ['-cf', imageArchive, '-C', layout, 'index.json', 'oci-layout', 'blobs'],
    { encoding: 'utf8' }
  );
  if (tar.status !== 0) {
    throw new Error(tar.stderr);
  }
  fs.rmSync(layout, { force: true, recursive: true });

  const registryMetadata = {
    schema_version: '1.0.0',
    npm: npmExpected({
      packageJson,
      tarball,
      tarballBytes: fs.readFileSync(tarball),
    }),
    ghcr: {
      image: 'ghcr.io/vectormethods/videovector-mcp-server',
      tag: '2.0.2',
      digest: `sha256:${imageDigest}`,
      config_digest: `sha256:${configDigest}`,
      labels,
    },
    mcp_registry: {
      server: mcpProjection(server),
      server_json_sha256: sha256(fs.readFileSync(serverPath)),
    },
  };
  const registryPath = path.join(bundle, 'registry-metadata.json');
  fs.writeFileSync(registryPath, stableJson(registryMetadata));
  const descriptor = (target: string, artifactPath: string, kind: string) => ({
    kind,
    path: artifactPath,
    sha256: sha256(fs.readFileSync(target)),
    size: fs.statSync(target).size,
  });
  fs.writeFileSync(
    path.join(bundle, 'release-manifest.json'),
    stableJson({
      schema_version: '1.0.0',
      package: { name: packageJson.name, version: packageJson.version },
      repository: 'VectorMethods/videovector-mcp-server',
      source_sha: 'a'.repeat(40),
      tag: 'videovector-mcp-v2.0.2',
      tag_sha: 'a'.repeat(40),
      source_date_epoch: 1_700_000_000,
      release_body_sha256: 'b'.repeat(64),
      artifacts: [
        descriptor(
          tarball,
          `npm/${path.basename(tarball)}`,
          'npm-tarball'
        ),
        descriptor(
          imageArchive,
          'image/videovector-mcp-server.oci.tar',
          'oci-image'
        ),
        descriptor(serverPath, 'mcp/server.json', 'mcp-registry-metadata'),
      ],
      image_digest: `sha256:${imageDigest}`,
      registry_metadata_path: 'registry-metadata.json',
      registry_metadata_sha256: sha256(fs.readFileSync(registryPath)),
      tool_versions: {
        node: 'v24.14.0',
        npm: '11.15.0',
        docker: 'Docker version 29.0.0',
        docker_buildx: 'github.com/docker/buildx v0.28.0',
      },
    })
  );
  return bundle;
}

describe('release registry verification', () => {
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

    expect(workflow.match(/ref: \$\{\{ inputs\.release_tag \}\}/g)).toHaveLength(1);
    expect(
      workflow.match(/ref: \$\{\{ needs\.guard\.outputs\.source_sha \}\}/g)
    ).toHaveLength(4);
    expect(workflow).not.toContain('registry-url:');
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
    expect(() =>
      verifyNpmVersion(expected, metadata, Buffer.from('different bytes'))
    ).toThrow(ReleaseArtifactError);
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
        {
          registryType: 'oci',
          identifier: 'ghcr.io/vectormethods/videovector-mcp-server:2.0.2',
          transport: { type: 'stdio' },
        },
      ],
    };
    const expected = { server: mcpProjection(server) };

    expect(() => verifyMcpVersion(expected, { server })).not.toThrow();
    expect(() =>
      verifyMcpVersion(expected, {
        server: { ...server, description: 'Unexpected metadata.' },
      })
    ).toThrow(ReleaseArtifactError);
  });

  it('accepts a GHCR version only at the attested manifest digest and labels', () => {
    const rawManifest = Buffer.from('remote image manifest');
    const digest = `sha256:${sha256(rawManifest)}`;
    const labels = {
      'io.modelcontextprotocol.server.name':
        'io.github.VectorMethods/videovector-mcp-server',
      'org.opencontainers.image.revision': 'a'.repeat(40),
      'org.opencontainers.image.version': '2.0.2',
    };
    const expected = { digest, labels };

    expect(() =>
      verifyImageVersion(expected, digest, rawManifest, {
        config: { Labels: labels },
      })
    ).not.toThrow();
    expect(() =>
      verifyImageVersion(expected, digest, Buffer.from('different manifest'), {
        config: { Labels: labels },
      })
    ).toThrow(ReleaseArtifactError);
    expect(() =>
      verifyImageVersion(expected, digest, rawManifest, {
        config: { Labels: { ...labels, 'org.opencontainers.image.version': '2.0.3' } },
      })
    ).toThrow(ReleaseArtifactError);
  });

  it('produces stable MCP metadata independent of package ordering', () => {
    const left = mcpProjection({
      name: 'server',
      version: '1.0.0',
      packages: [
        { registryType: 'oci', identifier: 'image', transport: { type: 'stdio' } },
        {
          registryType: 'npm',
          identifier: 'package',
          version: '1.0.0',
          transport: { type: 'stdio' },
        },
      ],
    });
    const right = mcpProjection({
      name: 'server',
      version: '1.0.0',
      packages: [...left.packages].reverse(),
    });

    expect(right).toEqual(left);
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

  it('resumes missing atomic registries from only the attested bundle bytes', async () => {
    const bundle = fakeBundle();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    const npmDestination = path.join(bundle, 'publish-npm');
    const mcpDestination = path.join(bundle, 'publish-mcp');

    expect(
      await main([
        'npm-status',
        '--bundle',
        bundle,
        '--write-missing',
        npmDestination,
      ])
    ).toBe(3);
    expect(
      await main([
        'mcp-status',
        '--bundle',
        bundle,
        '--write-missing',
        mcpDestination,
      ])
    ).toBe(3);
    expect(fs.readdirSync(npmDestination)).toEqual([
      'vectormethods-videovector-mcp-server-2.0.2.tgz',
    ]);
    expect(fs.readFileSync(path.join(mcpDestination, 'server.json'))).toEqual(
      fs.readFileSync(path.join(bundle, 'mcp/server.json'))
    );
  });
});
