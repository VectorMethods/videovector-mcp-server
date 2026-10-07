#!/usr/bin/env node

/**
 * Build and verify the immutable MCP release bundle.
 *
 * npm, GHCR, and MCP Registry publication are deliberately separate from this
 * builder. Every publisher consumes the same npm tarball, OCI archive, and
 * server.json recorded here.
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
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const SCHEMA_VERSION = '2.0.0';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_NPM_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_OCI_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OCI_ARCHIVE_ENTRIES = 40_000;
const MAX_OCI_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const OCI_IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_IMAGE_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REQUIRED_IMAGE_PLATFORMS = [
  'linux/amd64',
  'linux/arm64',
];
const DEFAULT_REPOSITORY = 'VectorMethods/videovector-mcp-server';
const EXPECTED_MCP_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const EXPECTED_MCP_NAME = 'io.github.VectorMethods/videovector-mcp-server';
const EXPECTED_PACKAGE_NAME = '@vectormethods/videovector-mcp-server';
const EXPECTED_NODE_ENGINE = '>=18.0.0';
const EXPECTED_PACKAGE_MANAGER = 'npm@11.15.0';
const EXPECTED_IMAGE_ENVIRONMENT = new Set([
  'NODE_ENV=production',
  'PORT=8080',
  'MCP_TRANSPORT_MODE=stdio',
  'NODE_VERSION=24.14.0',
  'YARN_VERSION=1.22.22',
]);
const EXPECTED_IMAGE_PATH =
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const EXPECTED_OCI_IMAGE = 'ghcr.io/vectormethods/videovector-mcp-server';
const PINNED_MCP_SCHEMA_SHA256 =
  '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0';
const PINNED_MCP_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'mcp-server-2025-12-11.schema.json'
);
const EXPECTED_PACKAGE_ENVIRONMENT = [
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
    isRequired: false,
    isSecret: false,
    default: 'https://api.vectormethods.com/api/v2',
  },
  {
    name: 'VIDEOVECTOR_TIMEOUT',
    description: 'Per-request timeout in milliseconds.',
    format: 'number',
    isRequired: false,
    isSecret: false,
    default: '90000',
  },
  {
    name: 'VIDEOVECTOR_MAX_RETRIES',
    description: 'Maximum retry count for retryable API failures.',
    format: 'number',
    isRequired: false,
    isSecret: false,
    default: '3',
  },
];
const SERVER_KEYS = [
  '$schema',
  'description',
  'name',
  'packages',
  'title',
  'version',
];
const NPM_PACKAGE_KEYS = [
  'environmentVariables',
  'identifier',
  'registryType',
  'transport',
  'version',
];
const OCI_PACKAGE_KEYS = [
  'environmentVariables',
  'identifier',
  'registryType',
  'transport',
];
const RELEASE_MANIFEST_KEYS = [
  'artifacts',
  'image_digest',
  'package',
  'registry_metadata_path',
  'registry_metadata_sha256',
  'release_body_sha256',
  'repository',
  'schema_version',
  'source_date_epoch',
  'source_sha',
  'tag',
  'tag_commit_sha',
  'tag_object_sha',
  'tool_versions',
];

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
    maxBuffer: options.maxBuffer ?? 100 * 1024 * 1024,
    timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
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
  const digest = createHash('sha256');
  const descriptor = fs.openSync(target, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const size = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (size === 0) {
        break;
      }
      digest.update(chunk.subarray(0, size));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
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

function isCanonicalSemver(value) {
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      String(value)
    );
  return match !== null && !(match[4] ?? '').split('.').some(
    (identifier) => (
      /^[0-9]+$/.test(identifier)
      && identifier.length > 1
      && identifier.startsWith('0')
    )
  );
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
  return run('tar', ['-xOf', archive, entry], {
    binary: true,
    maxBuffer: MAX_JSON_BYTES,
  });
}

function requireSafeOciArchive(archive) {
  const archiveSize = fs.statSync(archive).size;
  if (archiveSize <= 0 || archiveSize > MAX_OCI_ARCHIVE_BYTES) {
    throw new ReleaseArtifactError('OCI archive is outside its byte bound');
  }
  const entries = String(run('tar', ['-tf', archive]))
    .split(/\r?\n/)
    .filter(Boolean);
  const verboseEntries = String(run('tar', ['-tvf', archive]))
    .split(/\r?\n/)
    .filter(Boolean);
  const seen = new Set();
  if (entries.length === 0 || entries.length > MAX_OCI_ARCHIVE_ENTRIES) {
    throw new ReleaseArtifactError('OCI archive entry count is outside its bound');
  }
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (
      entry.startsWith('/')
      || entry.includes('\\')
      || path.posix.normalize(entry) !== entry
      || entry.split('/').includes('..')
      || seen.has(entry)
      || (
        normalized !== 'index.json'
        && normalized !== 'oci-layout'
        && normalized !== 'blobs'
        && normalized !== 'blobs/sha256'
        && !/^blobs\/sha256\/[0-9a-f]{64}$/.test(normalized)
      )
    ) {
      throw new ReleaseArtifactError(
        `OCI archive contains unsafe or duplicate entry ${entry}`
      );
    }
    seen.add(entry);
  }
  if (
    entries.filter((entry) => entry === 'index.json').length !== 1
    || entries.filter((entry) => entry === 'oci-layout').length !== 1
    || verboseEntries.some((entry) => !['-', 'd'].includes(entry[0]))
  ) {
    throw new ReleaseArtifactError(
      'OCI archive layout files are missing, duplicated, or use special entries'
    );
  }
  const layout = JSON.parse(
    Buffer.from(tarEntry(archive, 'oci-layout')).toString('utf8')
  );
  if (stableJson(layout) !== stableJson({ imageLayoutVersion: '1.0.0' })) {
    throw new ReleaseArtifactError('OCI archive layout version is invalid');
  }
}

function ociBlob(archive, descriptor, label, { capture = true } = {}) {
  if (
    !descriptor
    || !IMAGE_DIGEST_PATTERN.test(String(descriptor.digest ?? ''))
    || !Number.isSafeInteger(descriptor.size)
    || descriptor.size <= 0
    || descriptor.size > MAX_OCI_EXPANDED_BYTES
  ) {
    throw new ReleaseArtifactError(`${label} descriptor is invalid`);
  }
  const [algorithm, digest] = descriptor.digest.split(':', 2);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oci-blob.'));
  const extracted = path.join(temporary, 'blob');
  let descriptorFd;
  try {
    descriptorFd = fs.openSync(extracted, 'wx', 0o600);
    const result = spawnSync(
      'tar',
      ['-xOf', archive, `blobs/${algorithm}/${digest}`],
      {
        encoding: 'utf8',
        maxBuffer: MAX_JSON_BYTES,
        stdio: ['ignore', descriptorFd, 'pipe'],
        timeout: DEFAULT_COMMAND_TIMEOUT_MS,
      }
    );
    fs.closeSync(descriptorFd);
    descriptorFd = undefined;
    if (result.error || result.status !== 0) {
      throw new ReleaseArtifactError(
        `${label} blob extraction failed: ${
          result.error?.message ?? String(result.stderr ?? '').trim()
        }`
      );
    }
    const extractedSize = fs.statSync(extracted).size;
    if (
      extractedSize !== descriptor.size
      || `sha256:${sha256File(extracted)}` !== descriptor.digest
    ) {
      throw new ReleaseArtifactError(`${label} blob does not match its descriptor`);
    }
    if (!capture) {
      return undefined;
    }
    if (extractedSize > MAX_JSON_BYTES) {
      throw new ReleaseArtifactError(`${label} JSON blob exceeds its byte bound`);
    }
    return fs.readFileSync(extracted);
  } finally {
    if (descriptorFd !== undefined) {
      fs.closeSync(descriptorFd);
    }
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

function ociDescriptor(archive) {
  requireSafeOciArchive(archive);
  const index = JSON.parse(Buffer.from(tarEntry(archive, 'index.json')).toString('utf8'));
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new ReleaseArtifactError('OCI archive must contain one root index');
  }
  const rootDescriptor = index.manifests[0];
  if (rootDescriptor.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE) {
    throw new ReleaseArtifactError('OCI archive root must be an OCI image index');
  }
  const rootBytes = ociBlob(archive, rootDescriptor, 'OCI root index');
  const root = JSON.parse(rootBytes.toString('utf8'));
  if (
    root.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE
    || !Array.isArray(root.manifests)
  ) {
    throw new ReleaseArtifactError('OCI root index payload is invalid');
  }
  const platforms = root.manifests.map((manifestDescriptor) => {
    if (manifestDescriptor.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
      throw new ReleaseArtifactError('OCI platform entry is not an image manifest');
    }
    const osName = String(manifestDescriptor.platform?.os ?? '');
    const architecture = String(manifestDescriptor.platform?.architecture ?? '');
    const platform = `${osName}/${architecture}`;
    if (!REQUIRED_IMAGE_PLATFORMS.includes(platform)) {
      throw new ReleaseArtifactError(`OCI image contains unsupported platform ${platform}`);
    }
    const manifestBytes = ociBlob(
      archive,
      manifestDescriptor,
      `OCI ${platform} manifest`
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (
      manifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE
      || manifest.config?.mediaType !== 'application/vnd.oci.image.config.v1+json'
      || !Array.isArray(manifest.layers)
    ) {
      throw new ReleaseArtifactError(`OCI ${platform} manifest payload is invalid`);
    }
    for (const [layerIndex, layer] of manifest.layers.entries()) {
      ociBlob(
        archive,
        layer,
        `OCI ${platform} layer ${layerIndex}`,
        { capture: false }
      );
    }
    const configBytes = ociBlob(
      archive,
      manifest.config,
      `OCI ${platform} config`
    );
    const config = JSON.parse(configBytes.toString('utf8'));
    if (
      config.os !== osName
      || config.architecture !== architecture
    ) {
      throw new ReleaseArtifactError(
        `OCI ${platform} config platform differs from its index descriptor`
      );
    }
    return {
      os: osName,
      architecture,
      manifest_digest: manifestDescriptor.digest,
      config_digest: manifest.config.digest,
      config,
    };
  }).sort((left, right) => (
    `${left.os}/${left.architecture}`.localeCompare(
      `${right.os}/${right.architecture}`
    )
  ));
  const actualPlatforms = platforms.map(
    (platform) => `${platform.os}/${platform.architecture}`
  );
  if (stableJson(actualPlatforms) !== stableJson(REQUIRED_IMAGE_PLATFORMS)) {
    throw new ReleaseArtifactError(
      'OCI image must contain exactly linux/amd64 and linux/arm64'
    );
  }
  return {
    digest: rootDescriptor.digest,
    media_type: rootDescriptor.mediaType,
    platforms,
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

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseArtifactError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (stableJson(actualKeys) !== stableJson(canonicalKeys)) {
    throw new ReleaseArtifactError(`${label} contains non-canonical fields`);
  }
}

function validateOfficialServerSchema(serverJson) {
  const schemaBytes = fs.readFileSync(PINNED_MCP_SCHEMA_PATH);
  if (sha256Bytes(schemaBytes) !== PINNED_MCP_SCHEMA_SHA256) {
    throw new ReleaseArtifactError('Vendored MCP schema checksum differs');
  }
  const schema = JSON.parse(schemaBytes.toString('utf8'));
  if (schema.$id !== EXPECTED_MCP_SCHEMA) {
    throw new ReleaseArtifactError('Vendored MCP schema identity differs');
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(serverJson)) {
    const failures = (validate.errors ?? []).map((error) => (
      `${error.instancePath || '/'} ${error.keyword}`
    ));
    throw new ReleaseArtifactError(
      `server.json violates the pinned MCP schema: ${failures.join(', ')}`
    );
  }
}

function requireCanonicalPackageEnvironment(packageMetadata, registryType) {
  if (
    stableJson(packageMetadata.environmentVariables)
    !== stableJson(EXPECTED_PACKAGE_ENVIRONMENT)
  ) {
    throw new ReleaseArtifactError(
      `server.json ${registryType} environment metadata is inconsistent`
    );
  }
}

function requireStdioImageConfig(config) {
  const environment = Array.isArray(config?.config?.Env)
    ? config.config.Env
    : [];
  const values = new Set(environment.map(String));
  const pathValues = [...values].filter((entry) => entry.startsWith('PATH='));
  if (
    values.size !== environment.length
    || pathValues.length !== 1
    || pathValues[0] !== EXPECTED_IMAGE_PATH
    || stableJson([...values].filter((entry) => !entry.startsWith('PATH=')).sort())
      !== stableJson([...EXPECTED_IMAGE_ENVIRONMENT].sort())
    || stableJson(config?.config?.Cmd) !== stableJson(['node', 'dist/index.js'])
    || config?.config?.WorkingDir !== '/app'
    || config?.config?.User !== 'node'
    || !(
      config?.config?.Entrypoint === undefined
      || config.config.Entrypoint === null
      || stableJson(config.config.Entrypoint) === stableJson([])
    )
  ) {
    throw new ReleaseArtifactError(
      'OCI image runtime config differs from the canonical stdio contract'
    );
  }
}

export function validateProjectMetadata(
  packageJson,
  serverJson,
  { expectedOciDigest } = {}
) {
  validateOfficialServerSchema(serverJson);
  if (serverJson.remotes !== undefined) {
    throw new ReleaseArtifactError(
      'hosted remotes require a separate authenticated contract'
    );
  }
  assertExactKeys(serverJson, SERVER_KEYS, 'server.json');
  if (serverJson.$schema !== EXPECTED_MCP_SCHEMA) {
    throw new ReleaseArtifactError('server.json schema is not the pinned MCP schema');
  }
  if (
    packageJson.name !== EXPECTED_PACKAGE_NAME
    || packageJson.mcpName !== EXPECTED_MCP_NAME
    || serverJson.name !== EXPECTED_MCP_NAME
  ) {
    throw new ReleaseArtifactError('Package and MCP Registry identities differ');
  }
  if (
    packageJson.engines?.node !== EXPECTED_NODE_ENGINE
    || packageJson.packageManager !== EXPECTED_PACKAGE_MANAGER
  ) {
    throw new ReleaseArtifactError(
      'Package Node engine and package manager are not the supported release runtime'
    );
  }
  if (!isCanonicalSemver(packageJson.version)) {
    throw new ReleaseArtifactError('Package version is not canonical semantic versioning');
  }
  if (packageJson.version !== serverJson.version) {
    throw new ReleaseArtifactError('package.json and server.json versions differ');
  }
  if (packageJson.mcpName !== serverJson.name) {
    throw new ReleaseArtifactError('package.json mcpName and server.json name differ');
  }
  const packages = Array.isArray(serverJson.packages) ? serverJson.packages : [];
  if (packages.length !== 2) {
    throw new ReleaseArtifactError(
      'server.json must contain only the npm and OCI packages'
    );
  }
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
  const expectedOciIdentifier = expectedOciDigest === undefined
    ? `${EXPECTED_OCI_IMAGE}:${packageJson.version}`
    : `${EXPECTED_OCI_IMAGE}@${expectedOciDigest}`;
  if (
    !ociPackage
    || ociPackage.identifier !== expectedOciIdentifier
    || ociPackage.version !== undefined
    || ociPackage.transport?.type !== 'stdio'
  ) {
    throw new ReleaseArtifactError('server.json OCI metadata is inconsistent');
  }
  assertExactKeys(npmPackage, NPM_PACKAGE_KEYS, 'server.json npm package');
  assertExactKeys(ociPackage, OCI_PACKAGE_KEYS, 'server.json OCI package');
  assertExactKeys(npmPackage.transport, ['type'], 'server.json npm transport');
  assertExactKeys(ociPackage.transport, ['type'], 'server.json OCI transport');
  requireCanonicalPackageEnvironment(npmPackage, 'npm');
  requireCanonicalPackageEnvironment(ociPackage, 'OCI');
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
  const projection = structuredClone(server ?? {});
  if (Array.isArray(projection.packages)) {
    projection.packages.sort((left, right) => (
      `${String(left.registryType)}\u0000${String(left.identifier)}`
        .localeCompare(`${String(right.registryType)}\u0000${String(right.identifier)}`)
    ));
  }
  return sortJson(projection);
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
  assertExactKeys(
    manifest,
    RELEASE_MANIFEST_KEYS,
    'release-manifest.json'
  );
  assertExactKeys(manifest.package, ['name', 'version'], 'release package');
  assertExactKeys(
    manifest.tool_versions,
    ['docker', 'docker_buildx', 'node', 'npm'],
    'release tool versions'
  );
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new ReleaseArtifactError('Unsupported release manifest schema');
  }
  if (
    !GIT_OBJECT_PATTERN.test(String(manifest.source_sha ?? ''))
    || !GIT_OBJECT_PATTERN.test(String(manifest.tag_object_sha ?? ''))
    || !GIT_OBJECT_PATTERN.test(String(manifest.tag_commit_sha ?? ''))
    || manifest.tag_commit_sha !== manifest.source_sha
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
  if (stableJson(manifest.tool_versions) !== stableJson({
    node: '24.14.0',
    npm: '11.15.0',
    docker: '29.1.3',
    docker_buildx: '0.28.0',
  })) {
    throw new ReleaseArtifactError(
      'Release tool versions differ from the immutable toolchain policy'
    );
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
    assertExactKeys(
      artifact,
      ['kind', 'path', 'sha256', 'size'],
      'release artifact'
    );
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
    const artifactLimit = {
      'mcp-registry-metadata': MAX_JSON_BYTES,
      'npm-tarball': MAX_NPM_TARBALL_BYTES,
      'oci-image': MAX_OCI_ARCHIVE_BYTES,
    }[artifact.kind];
    if (
      artifactLimit === undefined
      || stat.size > artifactLimit
      || stat.size !== artifact.size
      || sha256File(target) !== artifact.sha256
    ) {
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
  if (
    manifest.package?.name !== packageJson.name
    || manifest.package?.version !== packageJson.version
    || manifest.tag !== `videovector-mcp-v${packageJson.version}`
  ) {
    throw new ReleaseArtifactError(
      'Release tag and package identity are not bound canonically'
    );
  }
  const { ociPackage } = validateProjectMetadata(packageJson, serverJson, {
    expectedOciDigest: manifest.image_digest,
  });
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
  const imageName = String(ociPackage.identifier).split('@', 1)[0];
  const labels = expectedLabels({
    repository: manifest.repository,
    sourceSha: manifest.source_sha,
    version: packageJson.version,
    mcpName: packageJson.mcpName,
  });
  for (const platform of image.platforms) {
    requireStdioImageConfig(platform.config);
    const actualLabels = platform.config?.config?.Labels ?? {};
    for (const [name, value] of Object.entries(labels)) {
      if (actualLabels[name] !== value) {
        throw new ReleaseArtifactError(
          `OCI ${platform.os}/${platform.architecture} label ${name} differs`
        );
      }
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
      media_type: image.media_type,
      platforms: image.platforms.map((platform) => ({
        architecture: platform.architecture,
        config_digest: platform.config_digest,
        manifest_digest: platform.manifest_digest,
        os: platform.os,
      })),
      labels,
    },
    mcp_registry: {
      server: mcpProjection(serverJson),
      server_json_sha256: sha256File(serverPath),
    },
  };
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
  const npmVersion = String(run('npm', ['--version'], { cwd: root })).trim();
  const dockerVersion = String(
    run('docker', ['--version'], { cwd: root })
  ).trim();
  const buildxVersion = String(
    run('docker', ['buildx', 'version'], { cwd: root })
  ).trim();
  if (
    process.version !== 'v24.14.0'
    || npmVersion !== '11.15.0'
    || !/^Docker version 29\.1\.3,/.test(dockerVersion)
    || !/\bv0\.28\.0\b/.test(buildxVersion)
  ) {
    throw new ReleaseArtifactError(
      'Release runtime differs from the immutable toolchain policy'
    );
  }
  return {
    node: '24.14.0',
    npm: '11.15.0',
    docker: '29.1.3',
    docker_buildx: '0.28.0',
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
  const tagRef = `refs/tags/${tag}`;
  const tagObjectSha = options.tag_object_sha
    ?? git(root, 'rev-parse', '--verify', tagRef);
  const tagCommitSha = options.tag_commit_sha
    ?? git(root, 'rev-parse', '--verify', `${tagRef}^{commit}`);
  if (
    !GIT_OBJECT_PATTERN.test(sourceSha)
    || !GIT_OBJECT_PATTERN.test(tagObjectSha)
    || !GIT_OBJECT_PATTERN.test(tagCommitSha)
    || git(root, 'cat-file', '-t', tagObjectSha) !== 'tag'
  ) {
    throw new ReleaseArtifactError(
      'Release provenance requires an annotated Git tag object'
    );
  }
  if (
    sourceSha !== tagCommitSha
    || git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== sourceSha
    || git(root, 'rev-parse', '--verify', tagRef) !== tagObjectSha
    || git(root, 'rev-parse', '--verify', `${tagRef}^{commit}`) !== tagCommitSha
  ) {
    throw new ReleaseArtifactError(
      'Release tag object, peeled commit, and source commit differ'
    );
  }
  if (!options.allow_dirty && git(root, 'status', '--porcelain', '--untracked-files=all')) {
    throw new ReleaseArtifactError('Release source must be clean');
  }
  if (fs.existsSync(output)) {
    verifyBundle(output, {
      tag,
      source_sha: sourceSha,
      tag_object_sha: tagObjectSha,
      tag_commit_sha: tagCommitSha,
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
  if (tag !== `videovector-mcp-v${packageJson.version}`) {
    throw new ReleaseArtifactError('Release tag does not match the package version');
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
    const tarballSize = fs.statSync(tarball).size;
    if (tarballSize <= 0 || tarballSize > MAX_NPM_TARBALL_BYTES) {
      throw new ReleaseArtifactError('npm pack tarball is outside its byte bound');
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
        REQUIRED_IMAGE_PLATFORMS.join(','),
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
      {
        cwd: root,
        env: environment,
        capture: false,
        timeout: 25 * 60 * 1000,
      }
    );
    const oci = ociDescriptor(imageArchive);
    for (const platform of oci.platforms) {
      requireStdioImageConfig(platform.config);
      const actualLabels = platform.config?.config?.Labels ?? {};
      for (const [name, value] of Object.entries(labels)) {
        if (actualLabels[name] !== value) {
          throw new ReleaseArtifactError(
            `OCI ${platform.os}/${platform.architecture} label ${name} differs`
          );
        }
      }
    }

    const serverTarget = path.join(mcpDirectory, 'server.json');
    const immutableServerJson = structuredClone(serverJson);
    const immutableOciPackage = immutableServerJson.packages.find(
      (entry) => entry.registryType === 'oci'
    );
    immutableOciPackage.identifier = `${image}@${oci.digest}`;
    validateProjectMetadata(packageJson, immutableServerJson, {
      expectedOciDigest: oci.digest,
    });
    writeJson(serverTarget, immutableServerJson);
    const tarballBytes = fs.readFileSync(tarball);
    const registryMetadata = {
      schema_version: SCHEMA_VERSION,
      npm: npmExpected({ packageJson, tarball, tarballBytes }),
      ghcr: {
        image,
        tag: packageJson.version,
        digest: oci.digest,
        media_type: oci.media_type,
        platforms: oci.platforms.map((platform) => ({
          architecture: platform.architecture,
          config_digest: platform.config_digest,
          manifest_digest: platform.manifest_digest,
          os: platform.os,
        })),
        labels,
      },
      mcp_registry: {
        server: mcpProjection(immutableServerJson),
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
      tag_object_sha: tagObjectSha,
      tag_commit_sha: tagCommitSha,
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
      tag,
      source_sha: sourceSha,
      tag_object_sha: tagObjectSha,
      tag_commit_sha: tagCommitSha,
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

export function verifyNpmVersion(expected, metadata, remoteTarball) {
  if (
    metadata.deprecated !== undefined
    && (
      typeof metadata.deprecated !== 'string'
      || metadata.deprecated.trim().length > 0
    )
  ) {
    throw new ReleaseArtifactError('npm version is deprecated');
  }
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

export function verifyMcpVersion(expected, metadata) {
  const candidate = metadata.server ?? metadata;
  if (stableJson(mcpProjection(candidate)) !== stableJson(expected.server)) {
    throw new ReleaseArtifactError('MCP Registry version metadata differs');
  }
  const official = metadata?._meta?.[
    'io.modelcontextprotocol.registry/official'
  ];
  if (official?.status !== 'active') {
    throw new ReleaseArtifactError('MCP Registry version is not active');
  }
}

export function verifyImageArchive(expected, archive) {
  const image = ociDescriptor(archive);
  if (
    image.digest !== expected.digest
    || image.media_type !== expected.media_type
    || stableJson(image.platforms.map((platform) => ({
      architecture: platform.architecture,
      config_digest: platform.config_digest,
      manifest_digest: platform.manifest_digest,
      os: platform.os,
    }))) !== stableJson(expected.platforms)
  ) {
    throw new ReleaseArtifactError('GHCR image descriptors differ');
  }
  for (const platform of image.platforms) {
    requireStdioImageConfig(platform.config);
    const labels = platform.config?.config?.Labels ?? {};
    for (const [name, value] of Object.entries(expected.labels)) {
      if (labels[name] !== value) {
        throw new ReleaseArtifactError(
          `GHCR ${platform.os}/${platform.architecture} label ${name} differs`
        );
      }
    }
  }
  return image;
}

function bundleInventory(bundle) {
  const root = fs.realpathSync(bundle);
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new ReleaseArtifactError(
          `Release bundle contains unsupported entry ${relative}`
        );
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else {
        entries.push({
          path: relative,
          sha256: sha256File(absolute),
          size: stat.size,
        });
      }
    }
  };
  visit(root);
  return entries;
}

export function compareBundles(left, right) {
  verifyBundle(left);
  verifyBundle(right);
  if (stableJson(bundleInventory(left)) !== stableJson(bundleInventory(right))) {
    throw new ReleaseArtifactError(
      'Independent release builds are not byte-for-byte reproducible'
    );
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/release-artifacts.mjs validate-project [--version VERSION]
  node scripts/release-artifacts.mjs build --output DIR --tag TAG --tag-object-sha SHA --tag-commit-sha SHA --release-body-sha256 HASH
  node scripts/release-artifacts.mjs verify-bundle --bundle DIR
  node scripts/release-artifacts.mjs compare-bundles --left DIR --right DIR`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  switch (options.command) {
    case 'validate-project': {
      const { packageJson } = projectMetadata(process.cwd());
      if (options.version !== undefined && options.version !== packageJson.version) {
        throw new ReleaseArtifactError(
          `Package version ${packageJson.version} does not match ${options.version}`
        );
      }
      console.log('validated');
      return 0;
    }
    case 'build':
      buildBundle(options);
      return 0;
    case 'verify-bundle':
      verifyBundle(path.resolve(required(options, 'bundle')), {
        tag: options.tag,
        source_sha: options.source_sha,
        tag_object_sha: options.tag_object_sha,
        tag_commit_sha: options.tag_commit_sha,
        release_body_sha256:
          options.release_body_sha256 === undefined
            ? undefined
            : requireSha256(options.release_body_sha256, 'release_body_sha256'),
      });
      console.log('verified');
      return 0;
    case 'compare-bundles':
      compareBundles(
        path.resolve(required(options, 'left')),
        path.resolve(required(options, 'right'))
      );
      console.log('reproducible');
      return 0;
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
