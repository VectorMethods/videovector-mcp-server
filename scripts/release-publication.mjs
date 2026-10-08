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
  verifyMcpVersion,
  verifyNpmVersion,
} from './release-artifacts.mjs';

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_NPM_TARBALL_BYTES = 256 * 1024 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const OIDC_SUBPROCESS_ENVIRONMENT = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'RUNNER_ENVIRONMENT',
];

export class PublicationError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PublicationError';
  }
}

const NPM_PROVENANCE_ENVIRONMENT = [
  'GITHUB_WORKFLOW_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_SERVER_URL',
  'GITHUB_EVENT_NAME',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_REF',
  'GITHUB_SHA',
  'RUNNER_ENVIRONMENT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
];
const MAX_ERROR_DETAIL_CHARS = 1_536;
const MAX_ERROR_CAUSES = 4;

function redactedErrorDetail(value, environment) {
  let detail = String(value);
  // npm's HTTP diagnostics can contain its complete OIDC capability URL.
  // Keep error codes and explanatory text, never authentication URLs or tokens.
  for (const [name, secret] of Object.entries(environment)) {
    if (
      /token|secret|password|credential|(?:^|_)auth(?:_|$)|(?:^|_)key(?:_|$)/i.test(name)
      && typeof secret === 'string'
      && secret.length >= 8
    ) {
      detail = detail.replaceAll(secret, '[redacted]');
    }
  }
  detail = detail
    .replaceAll('\\/', '/')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .replace(/\b(?:npm_|gh[pousr]_|github_pat_|sk_live_)[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, '$1 [redacted]')
    .replace(/((?:["']?)(?:authorization|_authToken|_auth|token|password|secret|api[_-]?key)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (detail.length > MAX_ERROR_DETAIL_CHARS) {
    detail = `${detail.slice(0, 512)}\n[truncated]\n${detail.slice(-1_000)}`;
  }
  return detail;
}

export function formatPublicationError(error, environment = process.env) {
  const details = [];
  const seen = new Set();
  let current = error;
  while (current !== undefined && current !== null && details.length < MAX_ERROR_CAUSES) {
    if (seen.has(current)) break;
    seen.add(current);
    const message = current instanceof Error
      ? current.message
      : typeof current === 'string' ? current : 'Unknown publication failure';
    details.push(redactedErrorDetail(message, environment));
    current = current instanceof Error ? current.cause : undefined;
  }
  return details.join('\nCaused by: ');
}

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

export function npmPublisherEnvironment(source = process.env) {
  requireOidcOnlyNpmEnvironment(source);
  const missing = NPM_PROVENANCE_ENVIRONMENT.filter((name) =>
    typeof source[name] !== 'string' || source[name].trim().length === 0
  );
  if (missing.length > 0) {
    throw new PublicationError(
      `npm provenance requires GitHub runner fields: ${missing.join(', ')}`
    );
  }
  for (const name of [
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
  ]) {
    if (!/^[1-9][0-9]*$/.test(source[name])) {
      throw new PublicationError(`npm provenance ${name} must be a positive integer`);
    }
  }
  if (source.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new PublicationError('npm provenance requires the GitHub-hosted runner used by this workflow');
  }
  return childEnvironment(['HOME', ...OIDC_SUBPROCESS_ENVIRONMENT], source);
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
  // Validate provenance before settlement: local configuration errors must not
  // consume the registry's propagation window or attempt any mutation.
  const publisherEnvironment = npmPublisherEnvironment();
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
        env: publisherEnvironment,
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
        env: publisherEnvironment,
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
        env: publisherEnvironment,
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

function printHelp() {
  console.log(`Usage:
  node scripts/release-publication.mjs publish-npm REQUEST_OPTIONS
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
        `[release] ${formatPublicationError(error)}`
      );
      process.exitCode = 1;
    });
}
