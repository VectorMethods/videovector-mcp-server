#!/usr/bin/env node

/**
 * Canonical release publication state machines.
 *
 * Every registry mutation follows the same contract:
 *   1. classify authoritative remote state without mutating;
 *   2. fail closed on conflict or unavailable state;
 *   3. attempt the mutation at most once;
 *   4. settle a lost response by polling authoritative state;
 *   5. succeed only after an exact read-after-write result.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ReleaseArtifactError,
  verifyBundle,
  verifyImageArchive,
  verifyMcpVersion,
  verifyNpmVersion,
} from './release-artifacts.mjs';

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
const EXPECTED_GHCR_IMAGE =
  'ghcr.io/vectormethods/videovector-mcp-server';
const EXPECTED_GHCR_OWNER = 'vectormethods';
const EXPECTED_GHCR_PACKAGE = 'videovector-mcp-server';
const EXPECTED_GITHUB_REPOSITORY =
  'VectorMethods/videovector-mcp-server';
const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const DEFAULT_SKOPEO_IMAGE =
  'quay.io/skopeo/stable@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4';
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_NPM_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_GHCR_CENSUS_PAGES = 5;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const GHCR_MISSING_PATTERNS = [
  /\bmanifest unknown\b/i,
  /\bname unknown\b/i,
  /\bstatus code 404\b/i,
  /\bstatus=404\b/i,
];
const OIDC_SUBPROCESS_ENVIRONMENT = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
];

export class PublicationError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PublicationError';
  }
}

class GhcrPackageConflictError extends PublicationError {}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new PublicationError('A command is required');
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new PublicationError(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2).replaceAll('-', '_');
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PublicationError(`${token} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublicationError(`--${name.replaceAll('_', '-')} is required`);
  }
  return value;
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new PublicationError(
      `Cannot read ${target}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

function positiveBoundedInteger(value, fallback, name, maximum) {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate)
    || candidate <= 0
    || candidate > maximum
  ) {
    throw new PublicationError(`${name} is outside its allowed bound`);
  }
  return candidate;
}

function childEnvironment(extraNames = [], source = process.env) {
  const allowed = new Set([
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'PATH',
    'SystemRoot',
    'TMP',
    'TMPDIR',
    'TEMP',
    ...extraNames,
  ]);
  return Object.fromEntries(
    [...allowed]
      .filter((name) => typeof source[name] === 'string')
      .map((name) => [name, source[name]])
  );
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError?.code !== 'ESRCH' && error?.code !== 'ESRCH') {
        throw fallbackError;
      }
    }
  }
}

export async function runResult(command, args, options = {}) {
  if (
    typeof command !== 'string'
    || command.length === 0
    || !Array.isArray(args)
    || args.some((argument) => typeof argument !== 'string')
  ) {
    throw new PublicationError('Subprocess identity is invalid');
  }
  const timeoutMs = positiveBoundedInteger(
    options.timeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    'Subprocess timeout',
    15 * 60 * 1000
  );
  const maxOutputBytes = positiveBoundedInteger(
    options.maxOutputBytes,
    DEFAULT_COMMAND_OUTPUT_BYTES,
    'Subprocess output bound',
    16 * 1024 * 1024
  );
  const terminationGraceMs = positiveBoundedInteger(
    options.terminationGraceMs,
    DEFAULT_TERMINATION_GRACE_MS,
    'Subprocess termination grace',
    10_000
  );
  const environment = options.env ?? childEnvironment();
  const deadline = Date.now() + timeoutMs;

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        status: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const output = { stderr: [], stdout: [] };
    const outputBytes = { stderr: 0, stdout: 0 };
    let forcedDetail;
    let finished = false;
    let killTimer;

    const terminate = (detail) => {
      if (forcedDetail !== undefined || finished) {
        return;
      }
      forcedDetail = detail;
      try {
        signalProcessGroup(child, 'SIGTERM');
      } catch (error) {
        forcedDetail += `; SIGTERM failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      killTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, 'SIGKILL');
        } catch (error) {
          forcedDetail += `; SIGKILL failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }, terminationGraceMs);
      killTimer.unref();
    };

    const capture = (name, chunk) => {
      if (finished) {
        return;
      }
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes[name]);
      if (remaining > 0) {
        output[name].push(bytes.subarray(0, remaining));
        outputBytes[name] += Math.min(bytes.length, remaining);
      }
      if (bytes.length > remaining) {
        terminate(`${name} exceeded ${maxOutputBytes} bytes`);
      }
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));

    const deadlineTimer = setTimeout(() => {
      terminate(`absolute deadline exceeded after ${timeoutMs}ms`);
    }, Math.max(1, deadline - Date.now()));
    deadlineTimer.unref();

    child.once('error', (error) => {
      terminate(`spawn failed: ${error.message}`);
    });
    child.once('close', (status, signal) => {
      finished = true;
      clearTimeout(deadlineTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (forcedDetail !== undefined) {
        try {
          signalProcessGroup(child, 'SIGKILL');
        } catch (error) {
          forcedDetail += `; final SIGKILL failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      const stdout = Buffer.concat(output.stdout, outputBytes.stdout).toString('utf8');
      const capturedStderr = Buffer.concat(
        output.stderr,
        outputBytes.stderr
      ).toString('utf8');
      const detail = forcedDetail === undefined
        ? capturedStderr
        : `${capturedStderr}${capturedStderr ? '\n' : ''}${forcedDetail}${
          signal ? ` (signal ${signal})` : ''
        }`;
      resolve({
        status: forcedDetail === undefined ? status : null,
        stdout,
        stderr: detail,
      });
    });
  });
}

async function run(command, args, options = {}) {
  const result = await runResult(command, args, options);
  if (result.status !== 0) {
    throw new PublicationError(
      `${command} exited ${String(result.status)}: ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function state(kind, detail) {
  return { state: kind, detail };
}

export async function settlePublication({
  attempts = 6,
  classify,
  delayMs = 3_000,
  label,
  mutate,
  sleep = delay,
}) {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new PublicationError('Settlement attempts must be a positive integer');
  }
  const initial = await classify();
  if (initial.state === 'exact') {
    return { outcome: 'replayed', mutationError: undefined };
  }
  if (initial.state !== 'missing') {
    throw new PublicationError(
      `${label} is ${initial.state}: ${initial.detail ?? 'no detail'}`
    );
  }

  let mutationError;
  try {
    await mutate();
  } catch (error) {
    mutationError = error;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observed = await classify();
    if (observed.state === 'exact') {
      return { outcome: 'published', mutationError };
    }
    if (observed.state === 'conflict') {
      throw new PublicationError(
        `${label} settled to conflicting state: ${observed.detail ?? 'no detail'}`,
        mutationError
      );
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw new PublicationError(
    `${label} did not settle to its exact authoritative state`,
    mutationError
  );
}

// npm can acknowledge publication minutes before its registry and packument
// become readable. Reconcile with reads only after one mutation; never republish.
export function settleNpmPublication(options) {
  return settlePublication({ attempts: 121, delayMs: 5_000, ...options });
}

export async function waitForExact({
  attempts = 6,
  classify,
  delayMs = 3_000,
  label,
  sleep = delay,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observed = await classify();
    if (observed.state === 'exact') {
      return;
    }
    if (observed.state === 'conflict') {
      throw new PublicationError(
        `${label} is conflicting: ${observed.detail ?? 'no detail'}`
      );
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw new PublicationError(`${label} did not become authoritatively readable`);
}

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(String(version));
  if (!match) {
    throw new PublicationError(`Invalid strict semantic version: ${version}`);
  }
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  for (const identifier of prerelease) {
    if (/^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0') {
      throw new PublicationError(
        `Numeric prerelease identifier has a leading zero: ${version}`
      );
    }
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function npmReleaseTags(version) {
  const parsed = parseSemver(version);
  return {
    target: parsed.prerelease.length === 0 ? 'latest' : 'next',
    temporary: `vv-release-${createHash('sha256')
      .update(version)
      .digest('hex')}`,
  };
}

async function fetchResponse(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new PublicationError('Registry request URL is malformed', error);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || (parsed.port && parsed.port !== '443')
  ) {
    throw new PublicationError('Registry request URL is unsafe');
  }
  try {
    return await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'videovector-mcp-release-publisher/1',
        ...(options.headers ?? {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new PublicationError(
      `Registry request failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

async function responseBytesBounded(response, limit, label) {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null
    && (!/^[0-9]+$/.test(contentLength) || BigInt(contentLength) > BigInt(limit))
  ) {
    throw new PublicationError(`${label} content length exceeds its bound`);
  }
  if (response.body === null) {
    throw new PublicationError(`${label} returned no response body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel('response exceeds its byte bound');
        throw new PublicationError(`${label} exceeds its byte bound`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof PublicationError) {
      throw error;
    }
    throw new PublicationError(`${label} body read failed`, error);
  }
  return Buffer.concat(chunks, size);
}

async function responseJson(response, label) {
  const payload = await responseBytesBounded(
    response,
    MAX_JSON_RESPONSE_BYTES,
    label
  );
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new PublicationError(`${label} returned malformed JSON`, error);
  }
}

async function responseBytesExact(response, expectedSize, label) {
  if (
    !Number.isSafeInteger(expectedSize)
    || expectedSize <= 0
    || expectedSize > MAX_NPM_TARBALL_BYTES
  ) {
    throw new ReleaseArtifactError(`${label} expected size is outside its bound`);
  }
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null
    && (
      !/^[0-9]+$/.test(contentLength)
      || BigInt(contentLength) !== BigInt(expectedSize)
    )
  ) {
    throw new ReleaseArtifactError(`${label} content length differs`);
  }
  if (response.body === null) {
    throw new PublicationError(`${label} returned no response body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > expectedSize) {
      await reader.cancel('artifact exceeds the attested size');
      throw new ReleaseArtifactError(`${label} exceeds the attested size`);
    }
    chunks.push(Buffer.from(value));
  }
  if (size !== expectedSize) {
    throw new ReleaseArtifactError(`${label} size differs`);
  }
  return Buffer.concat(chunks, size);
}

export function requireSafeNpmTarballUrl(value, registry, expected) {
  let candidate;
  let registryUrl;
  try {
    candidate = new URL(value);
    registryUrl = new URL(registry);
  } catch (error) {
    throw new ReleaseArtifactError('npm tarball URL is malformed', { cause: error });
  }
  if (
    candidate.protocol !== 'https:'
    || candidate.origin !== registryUrl.origin
    || candidate.username
    || candidate.password
    || candidate.hash
    || candidate.search
  ) {
    throw new ReleaseArtifactError('npm tarball URL is outside the exact registry');
  }
  const unscopedName = String(expected.name).split('/').at(-1);
  const canonical = new URL(
    `${registryUrl.toString().replace(/\/$/, '')}/${expected.name}/-/${unscopedName}-${expected.version}.tgz`
  );
  if (candidate.toString() !== canonical.toString()) {
    throw new ReleaseArtifactError('npm tarball URL path differs from package identity');
  }
  return candidate.toString();
}

async function bundleForRequest(options) {
  const bundle = path.resolve(required(options, 'bundle'));
  const releaseTag = required(options, 'tag');
  const sourceSha = required(options, 'source_sha');
  const tagObjectSha = required(options, 'tag_object_sha');
  const releaseBodySha256 = required(options, 'release_body_sha256');
  const manifest = verifyBundle(bundle, {
    tag: releaseTag,
    source_sha: sourceSha,
    tag_object_sha: tagObjectSha,
    tag_commit_sha: required(options, 'tag_commit_sha'),
    release_body_sha256: releaseBodySha256,
  });
  await run(
    'python3',
    [
      path.join(SOURCE_ROOT, 'scripts/controller_release_verifier.py'),
      '--bundle',
      bundle,
      '--release-tag',
      releaseTag,
      '--source-sha',
      sourceSha,
      '--tag-object-sha',
      tagObjectSha,
      '--release-body-sha256',
      releaseBodySha256,
    ],
    { cwd: SOURCE_ROOT, env: childEnvironment() }
  );
  const metadata = readJson(path.join(bundle, manifest.registry_metadata_path));
  return { bundle, manifest, metadata };
}

async function npmClassifier(expected, registry) {
  const versionUrl = `${registry}/${encodeURIComponent(expected.name)}/${encodeURIComponent(
    expected.version
  )}`;
  let response;
  try {
    response = await fetchResponse(versionUrl);
  } catch (error) {
    return state('unavailable', error.message);
  }
  if (response.status === 404) {
    return state('missing');
  }
  if (!response.ok) {
    return state('unavailable', `HTTP ${response.status}`);
  }
  try {
    const metadata = await responseJson(response, 'npm registry');
    if (typeof metadata.dist?.tarball !== 'string') {
      return state('conflict', 'npm version has no tarball');
    }
    const tarballUrl = requireSafeNpmTarballUrl(
      metadata.dist.tarball,
      registry,
      expected
    );
    const tarballResponse = await fetchResponse(tarballUrl);
    if (!tarballResponse.ok) {
      return state('unavailable', `npm tarball HTTP ${tarballResponse.status}`);
    }
    const tarball = await responseBytesExact(
      tarballResponse,
      expected.tarball.size,
      'npm tarball'
    );
    verifyNpmVersion(expected, metadata, tarball);
    return state('exact');
  } catch (error) {
    if (error instanceof ReleaseArtifactError) {
      return state('conflict', error.message);
    }
    return state('unavailable', error.message);
  }
}

export function requireNpmPublisherVersion(version) {
  if (version.trim() !== '11.21.0') {
    throw new PublicationError(
      'Use the reviewed npm 11.21.0 publisher with OIDC dist-tag support'
    );
  }
}

export function requireOidcOnlyNpmEnvironment(environment = process.env) {
  const forbidden = [
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'NPM_BOOTSTRAP_TOKEN',
    'NPM_CONFIG__AUTH',
    'NPM_CONFIG__AUTHTOKEN',
  ].filter((name) => String(environment[name] ?? '').length > 0);
  if (forbidden.length > 0) {
    throw new PublicationError(
      `Static npm credentials are forbidden: ${forbidden.join(', ')}`
    );
  }
  if (
    environment.GITHUB_ACTIONS !== 'true'
    || !environment.ACTIONS_ID_TOKEN_REQUEST_URL
    || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new PublicationError('npm publication requires GitHub OIDC identity');
  }
  const candidates = [
    path.join(process.cwd(), '.npmrc'),
    environment.HOME ? path.join(environment.HOME, '.npmrc') : undefined,
    environment.NPM_CONFIG_USERCONFIG,
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new PublicationError(`npm user configuration is unsafe: ${candidate}`);
    }
    const contents = fs.readFileSync(candidate, 'utf8');
    if (/(?:_authToken|_auth|_password|username)\s*=/i.test(contents)) {
      throw new PublicationError(`npm user configuration contains credentials`);
    }
  }
}

async function npmDistTags(packageName, registry) {
  const response = await fetchResponse(`${registry}/${encodeURIComponent(packageName)}`);
  if (!response.ok) {
    throw new PublicationError(`npm packument returned HTTP ${response.status}`);
  }
  const packument = await responseJson(response, 'npm packument');
  if (
    !packument['dist-tags']
    || typeof packument['dist-tags'] !== 'object'
    || Array.isArray(packument['dist-tags'])
  ) {
    throw new PublicationError('npm packument has no canonical dist-tags');
  }
  return packument['dist-tags'];
}

export async function reconcileNpmDistTags({
  addTag,
  expectedVersion,
  getTags,
  removeTag,
  settleOptions = {},
}) {
  const tags = npmReleaseTags(expectedVersion);
  const classifyTarget = async () => {
    let remote;
    try {
      remote = await getTags();
    } catch (error) {
      return state('unavailable', error.message);
    }
    const current = remote[tags.target];
    if (current === expectedVersion) {
      return state('exact');
    }
    if (current === undefined) {
      return state('missing');
    }
    let comparison;
    try {
      comparison = compareSemver(current, expectedVersion);
    } catch (error) {
      return state('conflict', error.message);
    }
    if (comparison > 0) {
      return state('exact', 'newer target tag preserved');
    }
    return state('missing', 'target tag requires monotonic advance');
  };
  await settleNpmPublication({
    ...settleOptions,
    label: `npm ${tags.target} dist-tag`,
    classify: classifyTarget,
    mutate: () => addTag(tags.target),
  });

  const classifyTemporary = async () => {
    let remote;
    try {
      remote = await getTags();
    } catch (error) {
      return state('unavailable', error.message);
    }
    return remote[tags.temporary] === expectedVersion
      ? state('missing', 'temporary tag still points at the release')
      : state('exact');
  };
  await settleNpmPublication({
    ...settleOptions,
    label: `npm ${tags.temporary} temporary dist-tag cleanup`,
    classify: classifyTemporary,
    mutate: () => removeTag(tags.temporary),
  });
}

async function publishNpm(options) {
  const { bundle, metadata } = await bundleForRequest(options);
  requireNpmPublisherVersion(await run('npm', ['--version']));
  const expected = metadata.npm;
  const registry = String(options.registry_url ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, '');
  const tarball = path.join(bundle, 'npm', expected.tarball.filename);
  const tags = npmReleaseTags(expected.version);
  const result = await settleNpmPublication({
    label: `npm ${expected.name}@${expected.version}`,
    classify: () => npmClassifier(expected, registry),
    mutate: async () => {
      requireOidcOnlyNpmEnvironment();
      await run('npm', [
        'publish',
        tarball,
        '--access',
        'public',
        '--provenance',
        '--tag',
        tags.temporary,
        '--registry',
        `${registry}/`,
      ], {
        env: childEnvironment([
          'HOME',
          ...OIDC_SUBPROCESS_ENVIRONMENT,
        ]),
      });
    },
  });
  await reconcileNpmDistTags({
    expectedVersion: expected.version,
    getTags: () => npmDistTags(expected.name, registry),
    addTag: async (tag) => {
      requireOidcOnlyNpmEnvironment();
      await run('npm', [
        'dist-tag',
        'add',
        `${expected.name}@${expected.version}`,
        tag,
        '--registry',
        `${registry}/`,
      ], {
        env: childEnvironment([
          'HOME',
          ...OIDC_SUBPROCESS_ENVIRONMENT,
        ]),
      });
    },
    removeTag: async (tag) => {
      requireOidcOnlyNpmEnvironment();
      await run('npm', [
        'dist-tag',
        'rm',
        expected.name,
        tag,
        '--registry',
        `${registry}/`,
      ], {
        env: childEnvironment([
          'HOME',
          ...OIDC_SUBPROCESS_ENVIRONMENT,
        ]),
      });
    },
  });
  console.log(`[release] npm ${result.outcome} and dist-tags reconciled`);
}

async function mcpClassifier(expected, registry) {
  const url = mcpVersionUrl(expected.server, registry);
  let response;
  try {
    response = await fetchResponse(url);
  } catch (error) {
    return state('unavailable', error.message);
  }
  if (response.status === 404) {
    return state('missing');
  }
  if (!response.ok) {
    return state('unavailable', `HTTP ${response.status}`);
  }
  try {
    verifyMcpVersion(expected, await responseJson(response, 'MCP Registry'));
    return state('exact');
  } catch (error) {
    return error instanceof ReleaseArtifactError
      ? state('conflict', error.message)
      : state('unavailable', error.message);
  }
}

export function mcpVersionUrl(server, registry) {
  return `${String(registry).replace(/\/$/, '')}/v0.1/servers/${encodeURIComponent(
    server.name
  )}/versions/${encodeURIComponent(server.version)}?include_deleted=true`;
}

async function publishMcp(options) {
  const { bundle, metadata } = await bundleForRequest(options);
  const expected = metadata.mcp_registry;
  const registry = String(options.registry_url ?? DEFAULT_MCP_REGISTRY).replace(/\/$/, '');
  const publisher = path.resolve(required(options, 'publisher'));
  if (
    !fs.existsSync(publisher)
    || !fs.lstatSync(publisher).isFile()
    || fs.lstatSync(publisher).isSymbolicLink()
  ) {
    throw new PublicationError(`MCP publisher is unavailable: ${publisher}`);
  }
  const publishDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'videovector-mcp-publish.')
  );
  try {
    const publisherHome = path.join(publishDirectory, '.publisher-home');
    fs.mkdirSync(publisherHome, { mode: 0o700 });
    fs.copyFileSync(
      path.join(bundle, 'mcp', 'server.json'),
      path.join(publishDirectory, 'server.json')
    );
    const result = await settlePublication({
      label: `MCP Registry ${expected.server.name}@${expected.server.version}`,
      classify: () => mcpClassifier(expected, registry),
      mutate: async () => {
        await run(publisher, ['login', 'github-oidc'], {
          cwd: publishDirectory,
          env: {
            ...childEnvironment(OIDC_SUBPROCESS_ENVIRONMENT),
            HOME: publisherHome,
          },
        });
        await run(publisher, ['publish'], {
          cwd: publishDirectory,
          env: {
            ...childEnvironment(),
            HOME: publisherHome,
          },
        });
      },
    });
    console.log(`[release] MCP Registry ${result.outcome}`);
  } finally {
    fs.rmSync(publishDirectory, { force: true, recursive: true });
  }
}

function skopeoArguments({
  authenticated,
  skopeoImage,
  workspace,
  workspaceReadOnly = false,
}) {
  const args = ['run', '--rm'];
  const dockerConfigDirectory =
    process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker');
  if (!path.isAbsolute(dockerConfigDirectory)) {
    throw new PublicationError('Docker credential directory must be absolute');
  }
  const dockerConfig = path.join(dockerConfigDirectory, 'config.json');
  if (authenticated) {
    if (!fs.existsSync(dockerConfigDirectory) || !fs.existsSync(dockerConfig)) {
      throw new PublicationError('Authenticated GHCR inspection has no Docker config');
    }
    const directoryStat = fs.lstatSync(dockerConfigDirectory);
    const configStat = fs.lstatSync(dockerConfig);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.mode & 0o077
      || !configStat.isFile()
      || configStat.isSymbolicLink()
      || configStat.mode & 0o077
      || configStat.size <= 0
      || configStat.size > 1024 * 1024
    ) {
      throw new PublicationError(
        'Authenticated GHCR inspection Docker config is unsafe'
      );
    }
    args.push(
      '-e',
      'REGISTRY_AUTH_FILE=/auth/config.json',
      '-v',
      `${dockerConfig}:/auth/config.json:ro`
    );
  }
  if (workspace !== undefined) {
    args.push(
      '-v',
      `${workspace}:/workspace${workspaceReadOnly ? ':ro' : ''}`
    );
  }
  args.push(skopeoImage);
  return args;
}

export function skopeoCopyArguments(source, destination) {
  if (
    typeof source !== 'string'
    || source.length === 0
    || typeof destination !== 'string'
    || destination.length === 0
  ) {
    throw new PublicationError(
      'Skopeo copy requires exact source and destination identities'
    );
  }
  return [
    'copy',
    '--all',
    '--preserve-digests',
    '--retry-times',
    '3',
    source,
    destination,
  ];
}

async function ghcrCensus(expected, githubToken) {
  if (!githubToken) {
    return state('unavailable', 'GITHUB_TOKEN is required for GHCR census');
  }
  const parsed = /^ghcr\.io\/([^/]+)\/(.+)$/.exec(expected.image);
  if (!parsed) {
    return state('unavailable', 'GHCR image identity is invalid');
  }
  const owner = parsed[1];
  const packageName = parsed[2];
  for (let page = 1; page <= MAX_GHCR_CENSUS_PAGES; page += 1) {
    let response;
    try {
      response = await fetchResponse(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(
          packageName
        )}/versions?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${githubToken}`,
            'X-GitHub-Api-Version': '2026-03-10',
          },
        }
      );
    } catch (error) {
      return state('unavailable', error.message);
    }
    if (page === 1 && response.status === 404) {
      return state('missing', 'GHCR package is absent');
    }
    if (!response.ok) {
      return state('unavailable', `GitHub Packages HTTP ${response.status}`);
    }
    let versions;
    try {
      versions = await responseJson(response, 'GitHub Packages');
    } catch (error) {
      return state('unavailable', error.message);
    }
    if (!Array.isArray(versions)) {
      return state('unavailable', 'GitHub Packages returned a non-array response');
    }
    if (versions.some((entry) => (
      Array.isArray(entry.metadata?.container?.tags)
      && entry.metadata.container.tags.includes(expected.tag)
    ))) {
      return state('conflict', 'GHCR tag exists but could not be verified');
    }
    if (versions.length < 100) {
      return state('missing', 'complete GHCR package census confirms tag absence');
    }
  }
  return state(
    'unavailable',
    `GHCR census exceeded ${MAX_GHCR_CENSUS_PAGES} pages`
  );
}

function exactGhcrPackageIdentity(expected) {
  if (String(expected.image) !== EXPECTED_GHCR_IMAGE) {
    throw new GhcrPackageConflictError('GHCR image identity is not canonical');
  }
  return {
    owner: EXPECTED_GHCR_OWNER,
    packageName: EXPECTED_GHCR_PACKAGE,
    url:
      `https://api.github.com/orgs/${EXPECTED_GHCR_OWNER}/packages/container/`
      + EXPECTED_GHCR_PACKAGE,
  };
}

function ghcrApiHeaders(githubToken) {
  if (!githubToken) {
    throw new PublicationError('GITHUB_TOKEN is required for GHCR package access');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function verifyGhcrPackagePayload(payload, identity) {
  if (
    payload.name !== identity.packageName
    || payload.package_type !== 'container'
    || String(payload.owner?.login ?? '').toLowerCase() !== identity.owner
    || payload.owner?.type !== 'Organization'
  ) {
    throw new GhcrPackageConflictError(
      'GHCR package differs from the exact organization package identity'
    );
  }
  if (!['private', 'public'].includes(payload.visibility)) {
    throw new GhcrPackageConflictError(
      'GHCR package visibility is not convergible'
    );
  }
  return payload.visibility;
}

async function readGhcrPackage(expected, githubToken) {
  const identity = exactGhcrPackageIdentity(expected);
  const response = await fetchResponse(identity.url, {
    headers: ghcrApiHeaders(githubToken),
  });
  if (response.status === 404) {
    return { identity, visibility: 'absent' };
  }
  if (!response.ok) {
    throw new PublicationError(
      `GHCR package inspection returned HTTP ${response.status}`
    );
  }
  const payload = await responseJson(response, 'GHCR package identity');
  return {
    identity,
    visibility: verifyGhcrPackagePayload(payload, identity),
  };
}

export async function requirePublicGhcrPackage(expected, githubToken) {
  const observed = await readGhcrPackage(expected, githubToken);
  if (observed.visibility !== 'public') {
    throw new PublicationError(
      'GHCR package must already exist with the exact public organization identity'
    );
  }
}

export async function classifyGhcrBootstrapVisibility(expected, githubToken) {
  try {
    const observed = await readGhcrPackage(expected, githubToken);
    if (observed.visibility === 'public') {
      return state('exact', 'exact GHCR package is public');
    }
    if (observed.visibility === 'private') {
      return state(
        'conflict',
        'exact GHCR package exists but does not inherit public visibility'
      );
    }
    return state('missing', 'exact GHCR package does not exist yet');
  } catch (error) {
    return state(
      error instanceof GhcrPackageConflictError ? 'conflict' : 'unavailable',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function requireExactPublicSourceRepository(githubToken) {
  const response = await fetchResponse(
    `https://api.github.com/repos/${EXPECTED_GITHUB_REPOSITORY}`,
    { headers: ghcrApiHeaders(githubToken) }
  );
  if (!response.ok) {
    throw new PublicationError(
      `GHCR bootstrap source repository inspection returned HTTP ${response.status}`
    );
  }
  const payload = await responseJson(
    response,
    'GHCR bootstrap source repository'
  );
  if (
    payload.full_name !== EXPECTED_GITHUB_REPOSITORY
    || payload.name !== EXPECTED_GHCR_PACKAGE
    || payload.owner?.login !== 'VectorMethods'
    || payload.owner?.type !== 'Organization'
    || payload.private !== false
    || payload.visibility !== 'public'
  ) {
    throw new PublicationError(
      'GHCR bootstrap requires the exact public source repository identity'
    );
  }
}

export function classifyGhcrAbsence(skopeoFailure, census) {
  if (
    skopeoFailure.status === 0
    || !GHCR_MISSING_PATTERNS.some((pattern) => pattern.test(skopeoFailure.stderr))
  ) {
    return state(
      'unavailable',
      'GHCR registry did not return an authoritative missing response'
    );
  }
  if (census.state === 'missing') {
    return state('missing', census.detail);
  }
  return census.state === 'conflict'
    ? census
    : state('unavailable', census.detail);
}

async function ghcrClassifier({
  expected,
  githubToken,
  skopeoImage,
}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'videovector-ghcr-read.'));
  const archive = path.join(workspace, 'remote.oci.tar');
  try {
    const result = await runResult('docker', [
      ...skopeoArguments({ authenticated: true, skopeoImage, workspace }),
      ...skopeoCopyArguments(
        `docker://${expected.image}:${expected.tag}`,
        'oci-archive:/workspace/remote.oci.tar'
      ),
    ], {
      env: childEnvironment(['DOCKER_CONFIG', 'HOME']),
      timeoutMs: 90_000,
    });
    if (result.status === 0) {
      try {
        verifyImageArchive(expected, archive);
        return state('exact');
      } catch (error) {
        return state('conflict', error.message);
      }
    }
    const census = await ghcrCensus(expected, githubToken);
    return classifyGhcrAbsence(result, census);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
}

async function publicGhcrClassifier(expected, skopeoImage) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'videovector-ghcr-public.'));
  const archive = path.join(workspace, 'public.oci.tar');
  try {
    const result = await runResult('docker', [
      ...skopeoArguments({ authenticated: false, skopeoImage, workspace }),
      ...skopeoCopyArguments(
        `docker://${expected.image}:${expected.tag}`,
        'oci-archive:/workspace/public.oci.tar'
      ),
    ], {
      env: childEnvironment(['DOCKER_CONFIG', 'HOME']),
      timeoutMs: 90_000,
    });
    if (result.status !== 0) {
      return state('unavailable', result.stderr.trim());
    }
    try {
      verifyImageArchive(expected, archive);
      return state('exact');
    } catch (error) {
      return state('conflict', error.message);
    }
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
}

async function verifyPublicGhcr(expected, skopeoImage) {
  await waitForExact({
    attempts: 3,
    delayMs: 3_000,
    label: `anonymous GHCR ${expected.image}:${expected.tag}`,
    classify: () => publicGhcrClassifier(expected, skopeoImage),
  });
}

async function copyGhcrBundle({ bundle, expected, skopeoImage }) {
  await run('docker', [
    ...skopeoArguments({
      authenticated: true,
      skopeoImage,
      workspace: bundle,
      workspaceReadOnly: true,
    }),
    ...skopeoCopyArguments(
      'oci-archive:/workspace/image/videovector-mcp-server.oci.tar',
      `docker://${expected.image}:${expected.tag}`
    ),
  ], {
    env: childEnvironment(['DOCKER_CONFIG', 'HOME']),
    timeoutMs: 120_000,
  });
}

async function publishGhcr(options) {
  const { bundle, metadata } = await bundleForRequest(options);
  const expected = metadata.ghcr;
  const githubToken = process.env.GITHUB_TOKEN;
  const skopeoImage = options.skopeo_image ?? DEFAULT_SKOPEO_IMAGE;
  // Creation defaults are not treated as a visibility contract. A separately
  // governed operation must pre-create/convert this exact package to public.
  await requirePublicGhcrPackage(expected, githubToken);
  const result = await settlePublication({
    attempts: 3,
    delayMs: 3_000,
    label: `GHCR ${expected.image}:${expected.tag}`,
    classify: () => ghcrClassifier({ expected, githubToken, skopeoImage }),
    mutate: () => copyGhcrBundle({ bundle, expected, skopeoImage }),
  });
  await verifyPublicGhcr(expected, skopeoImage);
  console.log(`[release] GHCR ${result.outcome} and anonymous read verified`);
}

async function preflightBootstrapGhcr(options) {
  const { metadata } = await bundleForRequest(options);
  const expected = metadata.ghcr;
  await requireExactPublicSourceRepository(process.env.GITHUB_TOKEN);
  const observed = await classifyGhcrBootstrapVisibility(
    expected,
    process.env.GITHUB_TOKEN
  );
  if (!['exact', 'missing'].includes(observed.state)) {
    throw new PublicationError(
      `GHCR bootstrap preflight is ${observed.state}: ${observed.detail}`
    );
  }
  console.log(
    `[release] GHCR bootstrap approved for exact digest ${expected.digest}`
  );
}

async function bootstrapGhcr(options) {
  const { bundle, metadata } = await bundleForRequest(options);
  const expected = metadata.ghcr;
  const githubToken = process.env.GITHUB_TOKEN;
  const skopeoImage = options.skopeo_image ?? DEFAULT_SKOPEO_IMAGE;
  await requireExactPublicSourceRepository(githubToken);
  const initialVisibility = await classifyGhcrBootstrapVisibility(
    expected,
    githubToken
  );
  if (!['exact', 'missing'].includes(initialVisibility.state)) {
    throw new PublicationError(
      `GHCR bootstrap package is ${initialVisibility.state}: `
      + initialVisibility.detail
    );
  }

  const imageResult = await settlePublication({
    attempts: 3,
    delayMs: 3_000,
    label: `GHCR bootstrap ${expected.image}:${expected.tag}`,
    classify: () => ghcrClassifier({ expected, githubToken, skopeoImage }),
    mutate: () => copyGhcrBundle({ bundle, expected, skopeoImage }),
  });
  await waitForExact({
    attempts: 5,
    delayMs: 2_000,
    label: `public GHCR package ${EXPECTED_GHCR_OWNER}/${EXPECTED_GHCR_PACKAGE}`,
    classify: () => classifyGhcrBootstrapVisibility(expected, githubToken),
  });
  await requirePublicGhcrPackage(expected, githubToken);
  await verifyPublicGhcr(expected, skopeoImage);
  console.log(
    `[release] GHCR bootstrap image ${imageResult.outcome}; public repository `
    + 'inheritance and anonymous exact-digest read verified'
  );
}

async function preflightGhcr(options) {
  const { metadata } = await bundleForRequest(options);
  await requirePublicGhcrPackage(metadata.ghcr, process.env.GITHUB_TOKEN);
  console.log('[release] GHCR public package identity preflight passed');
}

function printHelp() {
  console.log(`Usage:
  node scripts/release-publication.mjs publish-npm REQUEST_OPTIONS
  node scripts/release-publication.mjs preflight-bootstrap-ghcr REQUEST_OPTIONS
  node scripts/release-publication.mjs bootstrap-ghcr REQUEST_OPTIONS
  node scripts/release-publication.mjs preflight-ghcr REQUEST_OPTIONS
  node scripts/release-publication.mjs publish-ghcr REQUEST_OPTIONS
  node scripts/release-publication.mjs publish-mcp REQUEST_OPTIONS --publisher FILE

REQUEST_OPTIONS:
  --bundle DIR --tag TAG --source-sha SHA --tag-object-sha SHA
  --tag-commit-sha SHA --release-body-sha256 HASH`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  switch (options.command) {
    case 'publish-npm':
      await publishNpm(options);
      return 0;
    case 'bootstrap-ghcr':
      await bootstrapGhcr(options);
      return 0;
    case 'preflight-bootstrap-ghcr':
      await preflightBootstrapGhcr(options);
      return 0;
    case 'publish-ghcr':
      await publishGhcr(options);
      return 0;
    case 'preflight-ghcr':
      await preflightGhcr(options);
      return 0;
    case 'publish-mcp':
      await publishMcp(options);
      return 0;
    case 'help':
    case '--help':
      printHelp();
      return 0;
    default:
      throw new PublicationError(`Unsupported command: ${options.command}`);
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
