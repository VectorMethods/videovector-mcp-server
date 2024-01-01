#!/usr/bin/env node

/**
 * Build and verify the immutable MCP release bundle.
 *
 * npm, GHCR, and MCP Registry publication are deliberately separate from this
 * builder. Every publisher consumes the same npm tarball, OCI archive, and
 * server.json recorded here. Registry classifiers return:
 *   0: exact replay
 *   3: missing and safe to publish
 *   1: conflicting or unavailable (fail closed)
 */

import {
  createHash,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  spawnSync,
} from 'node:child_process';
import {
  fileURLToPath,
} from 'node:url';

const SCHEMA_VERSION = '1.0.0';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
const DEFAULT_REPOSITORY = 'VectorMethods/videovector-mcp-server';

export class ReleaseArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseArtifactError';
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.binary ? undefined : 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    stdio: options.capture === false ? 'inherit' : 'pipe',
  });
  if (result.error) {
    throw new ReleaseArtifactError(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '');
    throw new ReleaseArtifactError(
      `${command} exited ${result.status}: ${stderr.trim()}`
    );
  }
  return result.stdout ?? '';
}

function git(root, ...args) {
  return String(run('git', args, { cwd: root })).trim();
}

export function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha512Base64(value) {
  return createHash('sha512').update(value).digest('base64');
}

function sha1Hex(value) {
  return createHash('sha1').update(value).digest('hex');
}

function sha256File(target) {
  return sha256Bytes(fs.readFileSync(target));
}

function writeJson(target, value) {
  fs.writeFileSync(target, stableJson(value));
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new ReleaseArtifactError(
      `Cannot read ${target}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requireSha256(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ReleaseArtifactError(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new ReleaseArtifactError('A command is required');
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new ReleaseArtifactError(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2).replaceAll('-', '_');
    if (key === 'allow_dirty') {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ReleaseArtifactError(`${token} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReleaseArtifactError(`--${key.replaceAll('_', '-')} is required`);
  }
  return value;
}

function parsePackOutput(raw) {
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    if (raw[index] !== '[') {
      continue;
    }
    try {
      const parsed = JSON.parse(raw.slice(index));
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0]?.filename) {
        return parsed[0];
      }
    } catch {
      // npm can write lifecycle output before its JSON payload.
    }
  }
  throw new ReleaseArtifactError('npm pack did not return one JSON artifact');
}

function tarEntry(archive, entry) {
  return run('tar', ['-xOf', archive, entry], { binary: true });
}

function ociDescriptor(archive) {
  const index = JSON.parse(Buffer.from(tarEntry(archive, 'index.json')).toString('utf8'));
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new ReleaseArtifactError('OCI archive must contain one platform manifest');
  }
  const descriptor = index.manifests[0];
  if (!IMAGE_DIGEST_PATTERN.test(String(descriptor.digest ?? ''))) {
    throw new ReleaseArtifactError('OCI archive manifest digest is invalid');
  }
  const [algorithm, digest] = descriptor.digest.split(':', 2);
  const manifestBytes = Buffer.from(
    tarEntry(archive, `blobs/${algorithm}/${digest}`)
  );
  if (`sha256:${sha256Bytes(manifestBytes)}` !== descriptor.digest) {
    throw new ReleaseArtifactError('OCI manifest blob does not match its digest');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!IMAGE_DIGEST_PATTERN.test(String(manifest.config?.digest ?? ''))) {
    throw new ReleaseArtifactError('OCI image config digest is invalid');
  }
  const [configAlgorithm, configDigest] = manifest.config.digest.split(':', 2);
  const configBytes = Buffer.from(
    tarEntry(archive, `blobs/${configAlgorithm}/${configDigest}`)
  );
  if (`sha256:${sha256Bytes(configBytes)}` !== manifest.config.digest) {
    throw new ReleaseArtifactError('OCI config blob does not match its digest');
  }
  return {
    digest: descriptor.digest,
    media_type: descriptor.mediaType,
    config_digest: manifest.config.digest,
    config: JSON.parse(configBytes.toString('utf8')),
  };
}

function artifactDescriptor(target, relativePath, kind) {
  const stat = fs.statSync(target);
  return {
    kind,
    path: relativePath,
    sha256: sha256File(target),
    size: stat.size,
  };
}

function expectedLabels({ repository, sourceSha, version, mcpName }) {
  return {
    'io.modelcontextprotocol.server.name': mcpName,
    'org.opencontainers.image.revision': sourceSha,
    'org.opencontainers.image.source': `https://github.com/${repository}`,
    'org.opencontainers.image.version': version,
  };
}

function validateProjectMetadata(packageJson, serverJson) {
  if (packageJson.version !== serverJson.version) {
    throw new ReleaseArtifactError('package.json and server.json versions differ');
  }
  if (packageJson.mcpName !== serverJson.name) {
    throw new ReleaseArtifactError('package.json mcpName and server.json name differ');
  }
  const packages = Array.isArray(serverJson.packages) ? serverJson.packages : [];
  const npmPackage = packages.find((entry) => entry.registryType === 'npm');
  const ociPackage = packages.find((entry) => entry.registryType === 'oci');
  if (
    !npmPackage
    || npmPackage.identifier !== packageJson.name
    || npmPackage.version !== packageJson.version
    || npmPackage.transport?.type !== 'stdio'
  ) {
    throw new ReleaseArtifactError('server.json npm metadata is inconsistent');
  }
  if (!ociPackage || ociPackage.transport?.type !== 'stdio') {
    throw new ReleaseArtifactError('server.json OCI metadata is inconsistent');
  }
  return {
    packageJson,
    serverJson,
    npmPackage,
    ociPackage,
  };
}

function projectMetadata(root) {
  return validateProjectMetadata(
    readJson(path.join(root, 'package.json')),
    readJson(path.join(root, 'server.json'))
  );
}

export function mcpProjection(server) {
  const packages = Array.isArray(server?.packages) ? server.packages : [];
  return {
    name: server?.name,
    title: server?.title,
    description: server?.description,
    version: server?.version,
    packages: packages
      .map((entry) => ({
        registryType: entry.registryType,
        identifier: entry.identifier,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        transport: { type: entry.transport?.type },
      }))
      .sort((left, right) => String(left.registryType).localeCompare(String(right.registryType))),
  };
}

export function npmExpected({ packageJson, tarball, tarballBytes }) {
  return {
    name: packageJson.name,
    version: packageJson.version,
    mcpName: packageJson.mcpName,
    bin: packageJson.bin,
    engines: packageJson.engines,
    tarball: {
      filename: path.basename(tarball),
      sha1: sha1Hex(tarballBytes),
      sha256: sha256Bytes(tarballBytes),
      sha512: sha512Base64(tarballBytes),
      size: tarballBytes.length,
    },
  };
}

export function verifyBundle(bundle, expectations = {}) {
  const bundleRoot = fs.realpathSync(bundle);
  const manifest = readJson(path.join(bundleRoot, 'release-manifest.json'));
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new ReleaseArtifactError('Unsupported release manifest schema');
  }
  if (
    !GIT_OBJECT_PATTERN.test(String(manifest.source_sha ?? ''))
    || manifest.tag_sha !== manifest.source_sha
    || typeof manifest.tag !== 'string'
    || manifest.tag.length === 0
    || !Number.isSafeInteger(manifest.source_date_epoch)
    || manifest.source_date_epoch <= 0
    || !SHA256_PATTERN.test(String(manifest.release_body_sha256 ?? ''))
    || !IMAGE_DIGEST_PATTERN.test(String(manifest.image_digest ?? ''))
  ) {
    throw new ReleaseArtifactError('Release provenance fields are invalid');
  }
  const requiredTools = ['node', 'npm', 'docker', 'docker_buildx'];
  if (
    !manifest.tool_versions
    || typeof manifest.tool_versions !== 'object'
    || requiredTools.some((name) => (
      typeof manifest.tool_versions[name] !== 'string'
      || manifest.tool_versions[name].length === 0
      || manifest.tool_versions[name] === 'unavailable'
    ))
  ) {
    throw new ReleaseArtifactError('Release tool versions are incomplete');
  }
  for (const [field, expected] of Object.entries(expectations)) {
    if (expected !== undefined && manifest[field] !== expected) {
      throw new ReleaseArtifactError(`${field} does not match the release bundle`);
    }
  }
  if (
    manifest.registry_metadata_path !== 'registry-metadata.json'
    || typeof manifest.repository !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository)
  ) {
    throw new ReleaseArtifactError('Release provenance metadata is not canonical');
  }
  const unresolvedMetadataPath = path.join(
    bundleRoot,
    manifest.registry_metadata_path
  );
  if (!fs.existsSync(unresolvedMetadataPath)) {
    throw new ReleaseArtifactError('Registry metadata is missing');
  }
  const metadataPath = fs.realpathSync(unresolvedMetadataPath);
  if (path.dirname(metadataPath) !== bundleRoot) {
    throw new ReleaseArtifactError('Registry metadata path escapes the release bundle');
  }
  const seen = new Set();
  const kinds = new Set();
  if (!Array.isArray(manifest.artifacts)) {
    throw new ReleaseArtifactError('Release artifacts must be an array');
  }
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact.path !== 'string'
      || artifact.path.startsWith('/')
      || path.normalize(artifact.path) !== artifact.path
      || artifact.path.split(path.sep).includes('..')
      || seen.has(artifact.path)
      || typeof artifact.kind !== 'string'
      || kinds.has(artifact.kind)
      || typeof artifact.sha256 !== 'string'
      || !SHA256_PATTERN.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size <= 0
    ) {
      throw new ReleaseArtifactError('Artifact path or kind is invalid or duplicated');
    }
    seen.add(artifact.path);
    kinds.add(artifact.kind);
    const unresolvedTarget = path.join(bundleRoot, artifact.path);
    if (!fs.existsSync(unresolvedTarget)) {
      throw new ReleaseArtifactError(`Artifact is missing: ${artifact.path}`);
    }
    const target = fs.realpathSync(unresolvedTarget);
    if (!target.startsWith(`${bundleRoot}${path.sep}`)) {
      throw new ReleaseArtifactError('Artifact path escapes the release bundle');
    }
    const stat = fs.statSync(target);
    if (stat.size !== artifact.size || sha256File(target) !== artifact.sha256) {
      throw new ReleaseArtifactError(`Artifact bytes differ: ${artifact.path}`);
    }
  }
  const expectedKinds = new Set([
    'mcp-registry-metadata',
    'npm-tarball',
    'oci-image',
  ]);
  if (
    seen.size !== expectedKinds.size
    || [...kinds].some((kind) => !expectedKinds.has(kind))
  ) {
    throw new ReleaseArtifactError('Bundle must contain npm, OCI, and MCP artifacts');
  }
  const tarballArtifact = manifest.artifacts.find(
    (entry) => entry.kind === 'npm-tarball'
  );
  const imageArtifact = manifest.artifacts.find((entry) => entry.kind === 'oci-image');
  const serverArtifact = manifest.artifacts.find(
    (entry) => entry.kind === 'mcp-registry-metadata'
  );
  if (!tarballArtifact || !imageArtifact || !serverArtifact) {
    throw new ReleaseArtifactError('Bundle is missing a required release artifact');
  }
  if (
    imageArtifact.path !== 'image/videovector-mcp-server.oci.tar'
    || serverArtifact.path !== 'mcp/server.json'
    || !/^npm\/[A-Za-z0-9_.-]+\.tgz$/.test(tarballArtifact.path)
  ) {
    throw new ReleaseArtifactError('Release artifact path is not canonical');
  }
  const tarballPath = path.join(bundleRoot, tarballArtifact.path);
  const unsafeEntries = unsafeTarEntries(tarballPath);
  if (unsafeEntries.length > 0) {
    throw new ReleaseArtifactError(
      `npm tarball contains unsafe paths: ${unsafeEntries.join(', ')}`
    );
  }
  const packageJson = JSON.parse(
    Buffer.from(tarEntry(tarballPath, 'package/package.json')).toString('utf8')
  );
  const serverPath = path.join(bundleRoot, serverArtifact.path);
  const serverJson = readJson(serverPath);
  const { ociPackage } = validateProjectMetadata(packageJson, serverJson);
  const expectedTarballName = `${packageJson.name
    .replace(/^@/, '')
    .replaceAll('/', '-')}-${packageJson.version}.tgz`;
  if (tarballArtifact.path !== `npm/${expectedTarballName}`) {
    throw new ReleaseArtifactError('npm tarball path differs from package identity');
  }

  const image = ociDescriptor(path.join(bundleRoot, imageArtifact.path));
  if (image.digest !== manifest.image_digest) {
    throw new ReleaseArtifactError('OCI image digest differs from release manifest');
  }
  const imageName = String(ociPackage.identifier).replace(/:[^/:]+$/, '');
  const labels = expectedLabels({
    repository: manifest.repository,
    sourceSha: manifest.source_sha,
    version: packageJson.version,
    mcpName: packageJson.mcpName,
  });
  const actualLabels = image.config?.config?.Labels ?? {};
  for (const [name, value] of Object.entries(labels)) {
    if (actualLabels[name] !== value) {
      throw new ReleaseArtifactError(`OCI image label ${name} differs`);
    }
  }
  const tarballBytes = fs.readFileSync(tarballPath);
  const expectedMetadata = {
    schema_version: SCHEMA_VERSION,
    npm: npmExpected({ packageJson, tarball: tarballPath, tarballBytes }),
    ghcr: {
      image: imageName,
      tag: packageJson.version,
      digest: image.digest,
      config_digest: image.config_digest,
      labels,
    },
    mcp_registry: {
      server: mcpProjection(serverJson),
      server_json_sha256: sha256File(serverPath),
    },
  };
  if (
    manifest.package?.name !== packageJson.name
    || manifest.package?.version !== packageJson.version
  ) {
    throw new ReleaseArtifactError('Release manifest package identity differs');
  }
  const actualMetadata = readJson(metadataPath);
  if (stableJson(actualMetadata) !== stableJson(expectedMetadata)) {
    throw new ReleaseArtifactError('Registry metadata differs from release artifacts');
  }
  if (sha256Bytes(Buffer.from(stableJson(expectedMetadata))) !== manifest.registry_metadata_sha256) {
    throw new ReleaseArtifactError('Registry metadata hash differs');
  }
  return manifest;
}

function toolVersions(root) {
  const version = (command, args) => {
    try {
      return String(run(command, args, { cwd: root })).trim().split('\n')[0];
    } catch {
      return 'unavailable';
    }
  };
  return {
    node: process.version,
    npm: version('npm', ['--version']),
    docker: version('docker', ['--version']),
    docker_buildx: version('docker', ['buildx', 'version']),
  };
}

function unsafeTarEntries(tarball) {
  const listing = String(run('tar', ['-tzf', tarball]))
    .split(/\r?\n/)
    .filter(Boolean);
  const verboseListing = String(run('tar', ['-tvzf', tarball]))
    .split(/\r?\n/)
    .filter(Boolean);
  const unsafePattern =
    /(^|\/)(\.env(?:\..*)?|\.npmrc|.*\.(?:pem|p12|pfx|key)|.*service[-_]?account.*\.json|.*credentials?.*\.json)$/i;
  const unsafe = listing.filter((entry) => (
    entry.startsWith('/')
    || entry.includes('\\')
    || path.posix.normalize(entry) !== entry
    || entry.split('/').includes('..')
    || !entry.startsWith('package/')
    || unsafePattern.test(entry)
  ));
  if (listing.filter((entry) => entry === 'package/package.json').length !== 1) {
    unsafe.push('package/package.json (missing or duplicated)');
  }
  if (verboseListing.some((entry) => !['-', 'd'].includes(entry[0]))) {
    unsafe.push('npm tarball contains links or special files');
  }
  return [...new Set(unsafe)];
}

function buildBundle(options) {
  const root = path.resolve(options.root ?? '.');
  const output = path.resolve(required(options, 'output'));
  const tag = required(options, 'tag');
  const releaseBodySha256 = requireSha256(
    required(options, 'release_body_sha256'),
    'release_body_sha256'
  );
  const sourceSha = options.source_sha ?? git(root, 'rev-parse', 'HEAD');
  const tagSha = options.tag_sha ?? git(root, 'rev-list', '-n', '1', tag);
  if (sourceSha !== tagSha) {
    throw new ReleaseArtifactError('Release tag SHA must equal source SHA');
  }
  if (!options.allow_dirty && git(root, 'status', '--porcelain', '--untracked-files=all')) {
    throw new ReleaseArtifactError('Release source must be clean');
  }
  if (fs.existsSync(output)) {
    verifyBundle(output, {
      source_sha: sourceSha,
      tag_sha: tagSha,
      release_body_sha256: releaseBodySha256,
    });
    console.log(`[release] Reusing verified bundle at ${output}`);
    return;
  }

  const { packageJson, serverJson, ociPackage } = projectMetadata(root);
  if (options.version && options.version !== packageJson.version) {
    throw new ReleaseArtifactError(
      `Package version ${packageJson.version} does not match ${options.version}`
    );
  }
  const image = String(ociPackage.identifier).replace(/:[^/:]+$/, '');
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const sourceDateEpoch = Number(git(root, 'show', '-s', '--format=%ct', sourceSha));
  const labels = expectedLabels({
    repository,
    sourceSha,
    version: packageJson.version,
    mcpName: packageJson.mcpName,
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}.`));
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'videovector-mcp-npm-cache.'));
  try {
    const npmDirectory = path.join(staging, 'npm');
    const imageDirectory = path.join(staging, 'image');
    const mcpDirectory = path.join(staging, 'mcp');
    fs.mkdirSync(npmDirectory);
    fs.mkdirSync(imageDirectory);
    fs.mkdirSync(mcpDirectory);
    const environment = {
      ...process.env,
      LC_ALL: 'C.UTF-8',
      npm_config_cache: npmCache,
      SOURCE_DATE_EPOCH: String(sourceDateEpoch),
      TZ: 'UTC',
    };
    const packRaw = String(
      run(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          npmDirectory,
        ],
        { cwd: root, env: environment }
      )
    );
    const pack = parsePackOutput(packRaw);
    const tarball = path.join(npmDirectory, pack.filename);
    if (!fs.existsSync(tarball)) {
      throw new ReleaseArtifactError('npm pack tarball is missing');
    }
    const unsafeEntries = unsafeTarEntries(tarball);
    if (unsafeEntries.length > 0) {
      throw new ReleaseArtifactError(
        `npm tarball contains unsafe paths: ${unsafeEntries.join(', ')}`
      );
    }

    const imageArchive = path.join(imageDirectory, 'videovector-mcp-server.oci.tar');
    const labelArguments = Object.entries(labels).flatMap(([name, value]) => [
      '--label',
      `${name}=${value}`,
    ]);
    run(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        'linux/amd64',
        '--provenance=false',
        '--sbom=false',
        '--build-arg',
        `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
        ...labelArguments,
        '--tag',
        `${image}:${packageJson.version}`,
        '--output',
        `type=oci,dest=${imageArchive},rewrite-timestamp=true`,
        '.',
      ],
      { cwd: root, env: environment, capture: false }
    );
    const oci = ociDescriptor(imageArchive);
    const actualLabels = oci.config?.config?.Labels ?? {};
    for (const [name, value] of Object.entries(labels)) {
      if (actualLabels[name] !== value) {
        throw new ReleaseArtifactError(`OCI image label ${name} differs`);
      }
    }

    const serverTarget = path.join(mcpDirectory, 'server.json');
    fs.copyFileSync(path.join(root, 'server.json'), serverTarget);
    const tarballBytes = fs.readFileSync(tarball);
    const registryMetadata = {
      schema_version: SCHEMA_VERSION,
      npm: npmExpected({ packageJson, tarball, tarballBytes }),
      ghcr: {
        image,
        tag: packageJson.version,
        digest: oci.digest,
        config_digest: oci.config_digest,
        labels,
      },
      mcp_registry: {
        server: mcpProjection(serverJson),
        server_json_sha256: sha256File(serverTarget),
      },
    };
    const registryMetadataPath = path.join(staging, 'registry-metadata.json');
    writeJson(registryMetadataPath, registryMetadata);
    const artifacts = [
      artifactDescriptor(
        tarball,
        `npm/${path.basename(tarball)}`,
        'npm-tarball'
      ),
      artifactDescriptor(
        imageArchive,
        'image/videovector-mcp-server.oci.tar',
        'oci-image'
      ),
      artifactDescriptor(serverTarget, 'mcp/server.json', 'mcp-registry-metadata'),
    ];
    const versions = toolVersions(root);
    const unavailableTools = Object.entries(versions)
      .filter(([, value]) => value === 'unavailable')
      .map(([name]) => name);
    if (unavailableTools.length > 0) {
      throw new ReleaseArtifactError(
        `Release tool versions are unavailable: ${unavailableTools.join(', ')}`
      );
    }
    const manifest = {
      schema_version: SCHEMA_VERSION,
      package: { name: packageJson.name, version: packageJson.version },
      repository,
      source_sha: sourceSha,
      tag,
      tag_sha: tagSha,
      source_date_epoch: sourceDateEpoch,
      release_body_sha256: releaseBodySha256,
      artifacts,
      image_digest: oci.digest,
      registry_metadata_path: 'registry-metadata.json',
      registry_metadata_sha256: sha256File(registryMetadataPath),
      tool_versions: versions,
    };
    writeJson(path.join(staging, 'release-manifest.json'), manifest);
    verifyBundle(staging, {
      source_sha: sourceSha,
      tag_sha: tagSha,
      release_body_sha256: releaseBodySha256,
    });
    fs.renameSync(staging, output);
  } catch (error) {
    fs.rmSync(staging, { force: true, recursive: true });
    throw error;
  } finally {
    fs.rmSync(npmCache, { force: true, recursive: true });
  }
  console.log(`[release] Built immutable bundle at ${output}`);
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'videovector-mcp-release-verifier/1' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ReleaseArtifactError(
      `Registry request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new ReleaseArtifactError(`Registry returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ReleaseArtifactError('Registry returned malformed JSON');
  }
}

async function fetchBytes(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'videovector-mcp-release-verifier/1' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ReleaseArtifactError(
      `Registry artifact request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new ReleaseArtifactError(`Registry artifact returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function copyMissing(source, destination) {
  fs.rmSync(destination, { force: true, recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, path.basename(source)));
}

export function verifyNpmVersion(expected, metadata, remoteTarball) {
  if (
    metadata.name !== expected.name
    || metadata.version !== expected.version
    || metadata.mcpName !== expected.mcpName
    || stableJson(metadata.bin ?? {}) !== stableJson(expected.bin ?? {})
    || stableJson(metadata.engines ?? {}) !== stableJson(expected.engines ?? {})
  ) {
    throw new ReleaseArtifactError('npm version metadata differs');
  }
  if (typeof metadata.dist?.tarball !== 'string') {
    throw new ReleaseArtifactError('npm version has no tarball');
  }
  const remote = {
    filename: expected.tarball.filename,
    sha1: sha1Hex(remoteTarball),
    sha256: sha256Bytes(remoteTarball),
    sha512: sha512Base64(remoteTarball),
    size: remoteTarball.length,
  };
  if (
    stableJson(remote) !== stableJson(expected.tarball)
    || metadata.dist.shasum !== expected.tarball.sha1
    || metadata.dist.integrity !== `sha512-${expected.tarball.sha512}`
  ) {
    throw new ReleaseArtifactError('npm version exists but tarball bytes differ');
  }
}

async function npmStatus(options) {
  const bundle = path.resolve(required(options, 'bundle'));
  const manifest = verifyBundle(bundle);
  const expected = readJson(path.join(bundle, manifest.registry_metadata_path)).npm;
  const registry = String(options.registry_url ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, '');
  const url = `${registry}/${encodeURIComponent(expected.name)}/${encodeURIComponent(
    expected.version
  )}`;
  const metadata = await fetchJson(url);
  const tarballPath = path.join(bundle, 'npm', expected.tarball.filename);
  if (metadata === null) {
    if (options.write_missing) {
      copyMissing(tarballPath, path.resolve(options.write_missing));
    }
    console.log('missing');
    return 3;
  }
  if (typeof metadata.dist?.tarball !== 'string') {
    throw new ReleaseArtifactError('npm version has no tarball');
  }
  const remoteTarball = await fetchBytes(metadata.dist.tarball);
  verifyNpmVersion(expected, metadata, remoteTarball);
  console.log('exact');
  return 0;
}

export function verifyMcpVersion(expected, metadata) {
  const candidate = metadata.server ?? metadata;
  if (stableJson(mcpProjection(candidate)) !== stableJson(expected.server)) {
    throw new ReleaseArtifactError('MCP Registry version metadata differs');
  }
}

async function mcpStatus(options) {
  const bundle = path.resolve(required(options, 'bundle'));
  const manifest = verifyBundle(bundle);
  const expected = readJson(
    path.join(bundle, manifest.registry_metadata_path)
  ).mcp_registry;
  const registry = String(options.registry_url ?? DEFAULT_MCP_REGISTRY).replace(/\/$/, '');
  const url = `${registry}/v0.1/servers/${encodeURIComponent(
    expected.server.name
  )}/versions/${encodeURIComponent(expected.server.version)}`;
  const metadata = await fetchJson(url);
  const serverPath = path.join(bundle, 'mcp', 'server.json');
  if (metadata === null) {
    if (options.write_missing) {
      copyMissing(serverPath, path.resolve(options.write_missing));
    }
    console.log('missing');
    return 3;
  }
  verifyMcpVersion(expected, metadata);
  console.log('exact');
  return 0;
}

export function verifyImageVersion(expected, imageDigest, rawManifest, config) {
  const digest = `sha256:${sha256Bytes(rawManifest)}`;
  if (digest !== expected.digest || digest !== imageDigest) {
    throw new ReleaseArtifactError('GHCR image digest differs');
  }
  const labels = config.config?.Labels ?? config.Labels ?? {};
  for (const [name, value] of Object.entries(expected.labels)) {
    if (labels[name] !== value) {
      throw new ReleaseArtifactError(`GHCR image label ${name} differs`);
    }
  }
}

function imageStatus(options) {
  const bundle = path.resolve(required(options, 'bundle'));
  const manifest = verifyBundle(bundle);
  const expected = readJson(path.join(bundle, manifest.registry_metadata_path)).ghcr;
  const rawManifest = fs.readFileSync(path.resolve(required(options, 'raw_manifest')));
  const config = readJson(path.resolve(required(options, 'config')));
  verifyImageVersion(expected, manifest.image_digest, rawManifest, config);
  console.log('exact');
  return 0;
}

function printHelp() {
  console.log(`Usage:
  node scripts/release-artifacts.mjs build --output DIR --tag TAG --release-body-sha256 HASH
  node scripts/release-artifacts.mjs verify-bundle --bundle DIR
  node scripts/release-artifacts.mjs npm-status --bundle DIR [--write-missing DIR]
  node scripts/release-artifacts.mjs mcp-status --bundle DIR [--write-missing DIR]
  node scripts/release-artifacts.mjs image-status --bundle DIR --raw-manifest FILE --config FILE`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  switch (options.command) {
    case 'build':
      buildBundle(options);
      return 0;
    case 'verify-bundle':
      verifyBundle(path.resolve(required(options, 'bundle')), {
        source_sha: options.source_sha,
        tag_sha: options.tag_sha,
        release_body_sha256:
          options.release_body_sha256 === undefined
            ? undefined
            : requireSha256(options.release_body_sha256, 'release_body_sha256'),
      });
      console.log('verified');
      return 0;
    case 'npm-status':
      return npmStatus(options);
    case 'mcp-status':
      return mcpStatus(options);
    case 'image-status':
      return imageStatus(options);
    case 'help':
    case '--help':
      printHelp();
      return 0;
    default:
      throw new ReleaseArtifactError(`Unsupported command: ${options.command}`);
  }
}

const isDirectExecution =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        `[release] ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    });
}
