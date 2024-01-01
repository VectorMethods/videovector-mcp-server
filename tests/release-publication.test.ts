import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  PublicationError,
  compareSemver,
  mcpVersionUrl,
  npmReleaseTags,
  reconcileNpmDistTags,
  requireOidcOnlyNpmEnvironment,
  requireNpmPublisherVersion,
  requireSafeNpmTarballUrl,
  runResult,
  settleNpmPublication,
  settlePublication,
} from '../scripts/release-publication.mjs';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

describe('release publication state machines', () => {
  it('replays exact state without dispatching a mutation', async () => {
    const mutate = vi.fn();

    await expect(settlePublication({
      classify: async () => ({ state: 'exact' }),
      label: 'registry artifact',
      mutate,
      sleep: async () => undefined,
    })).resolves.toMatchObject({ outcome: 'replayed' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('fails closed when authoritative state is unavailable before mutation', async () => {
    const mutate = vi.fn();

    await expect(settlePublication({
      classify: async () => ({ state: 'unavailable', detail: 'timeout' }),
      label: 'registry artifact',
      mutate,
      sleep: async () => undefined,
    })).rejects.toThrow(/unavailable/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('settles a commit-then-error response without dispatching twice', async () => {
    let published = false;
    const mutate = vi.fn(async () => {
      published = true;
      throw new Error('connection reset after commit');
    });

    await expect(settlePublication({
      classify: async () => (
        published ? { state: 'exact' } : { state: 'missing' }
      ),
      label: 'registry artifact',
      mutate,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      outcome: 'published',
      mutationError: expect.any(Error),
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('bounds uncertain settlement and never retries the mutation', async () => {
    const mutate = vi.fn(async () => undefined);
    const classify = vi
      .fn()
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValue({ state: 'unavailable', detail: 'registry timeout' });

    await expect(settlePublication({
      attempts: 3,
      classify,
      label: 'registry artifact',
      mutate,
      sleep: async () => undefined,
    })).rejects.toThrow(/did not settle/);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(4);
  });

  it('fails immediately when a mutation settles to conflicting bytes', async () => {
    const mutate = vi.fn(async () => undefined);
    const classify = vi
      .fn()
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'conflict', detail: 'digest differs' });

    await expect(settlePublication({
      attempts: 5,
      classify,
      label: 'registry artifact',
      mutate,
      sleep: async () => undefined,
    })).rejects.toThrow(/conflicting state/);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('waits through npm registry propagation without publishing twice', async () => {
    let reads = 0;
    const mutate = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    await expect(settleNpmPublication({
      classify: async () => {
        reads += 1;
        if (reads === 1) return { state: 'missing' };
        if (reads < 96) return { state: reads % 2 ? 'missing' : 'unavailable' };
        return { state: 'exact' };
      },
      label: 'npm version',
      mutate,
      sleep,
    })).resolves.toMatchObject({ outcome: 'published' });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(94);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('bounds npm settlement to ten minutes and fails immediately on a conflict', async () => {
    const mutate = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const classify = vi.fn(async () => ({ state: 'missing' }));
    await expect(settleNpmPublication({ classify, label: 'npm version', mutate, sleep }))
      .rejects.toThrow(/did not settle/);
    expect(classify).toHaveBeenCalledTimes(122);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(120);
    expect(sleep.mock.calls.reduce((total, call) => total + Number(call[0]), 0))
      .toBe(600_000);

    const conflictSleep = vi.fn(async () => undefined);
    await expect(settleNpmPublication({
      classify: vi.fn().mockResolvedValueOnce({ state: 'missing' })
        .mockResolvedValue({ state: 'conflict', detail: 'digest mismatch' }),
      label: 'npm version',
      mutate,
      sleep: conflictSleep,
    })).rejects.toThrow(/conflicting state/);
    expect(conflictSleep).not.toHaveBeenCalled();
  });

  it('implements strict SemVer precedence and deterministic publication tags', () => {
    expect(compareSemver('2.0.2', '2.0.1')).toBe(1);
    expect(compareSemver('2.0.2-rc.10', '2.0.2-rc.2')).toBe(1);
    expect(compareSemver('2.0.2', '2.0.2-rc.10')).toBe(1);
    expect(compareSemver(
      '9007199254740993.0.0',
      '9007199254740992.999999999999999999.999999999999999999'
    )).toBe(1);
    expect(() => compareSemver('2.0.2-01', '2.0.2-1')).toThrow(
      PublicationError
    );
    expect(npmReleaseTags('2.0.2')).toEqual({
      target: 'latest',
      temporary:
        'vv-release-31186721be50d1033545dfeee9d6ee118b54fb1b974ea909ab2e960e0b7c049b',
    });
    expect(npmReleaseTags('2.1.0-rc.1')).toEqual({
      target: 'next',
      temporary:
        'vv-release-a21c2d5eb2c1cfb9d2530c9776e139decbd716c41eda738facebc5b3d0a9352e',
    });
  });

  it('rejects the build CLI before OIDC publication and accepts the reviewed publisher', () => {
    expect(() => requireNpmPublisherVersion('11.15.0')).toThrow(/OIDC dist-tag support/);
    expect(() => requireNpmPublisherVersion('11.21.0\n')).not.toThrow();
    expect(() => requireNpmPublisherVersion('11.22.0')).toThrow(/reviewed npm/);
  });

  it('requires GitHub OIDC and rejects every static npm token surface', () => {
    const oidc = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com',
      GITHUB_ACTIONS: 'true',
    };
    expect(() => requireOidcOnlyNpmEnvironment(oidc)).not.toThrow();
    for (const variable of [
      'NODE_AUTH_TOKEN',
      'NPM_TOKEN',
      'NPM_BOOTSTRAP_TOKEN',
      'NPM_CONFIG__AUTHTOKEN',
    ]) {
      expect(() => requireOidcOnlyNpmEnvironment({
        ...oidc,
        [variable]: 'static-secret',
      })).toThrow(/Static npm credentials/);
    }
    expect(() => requireOidcOnlyNpmEnvironment({ GITHUB_ACTIONS: 'true' }))
      .toThrow(/OIDC/);
  });

  it('accepts only the canonical anonymous npm tarball URL', () => {
    const expected = {
      name: '@vectormethods/videovector-mcp-server',
      version: '2.0.2',
    };
    expect(requireSafeNpmTarballUrl(
      'https://registry.npmjs.org/@vectormethods/'
        + 'videovector-mcp-server/-/videovector-mcp-server-2.0.2.tgz',
      'https://registry.npmjs.org',
      expected
    )).toContain('/-/videovector-mcp-server-2.0.2.tgz');
    for (const candidate of [
      'http://registry.npmjs.org/@vectormethods/videovector-mcp-server/-/videovector-mcp-server-2.0.2.tgz',
      'https://attacker.invalid/@vectormethods/videovector-mcp-server/-/videovector-mcp-server-2.0.2.tgz',
      'https://registry.npmjs.org/@vectormethods/videovector-mcp-server/-/other-2.0.2.tgz',
      'https://registry.npmjs.org/@vectormethods/videovector-mcp-server/-/videovector-mcp-server-2.0.2.tgz?token=leak',
    ]) {
      expect(() => requireSafeNpmTarballUrl(
        candidate,
        'https://registry.npmjs.org',
        expected
      )).toThrow();
    }
  });

  it('enforces an absolute deadline and kills TERM-ignoring descendants', async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'videovector-release-process.')
    );
    const descendantPidPath = path.join(temporary, 'descendant.pid');
    const descendantSource =
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const parentSource = [
      'const fs=require("node:fs");',
      'const {spawn}=require("node:child_process");',
      'process.on("SIGTERM",()=>{});',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(descendantSource)}],`
        + '{stdio:"ignore"});',
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));`,
      'setInterval(()=>{},1000);',
    ].join('');

    try {
      const started = Date.now();
      const result = await runResult(process.execPath, ['-e', parentSource], {
        maxOutputBytes: 8 * 1024,
        terminationGraceMs: 100,
        timeoutMs: 250,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.status).toBeNull();
      expect(result.stderr).toMatch(/absolute deadline/);
      const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch (error: any) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(temporary, { force: true, recursive: true });
    }
  });

  it('kills a stubborn descendant after the direct child accepts TERM', async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'videovector-release-descendant.')
    );
    const descendantPidPath = path.join(temporary, 'descendant.pid');
    const descendantSource =
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const parentSource = [
      'const fs=require("node:fs");',
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(descendantSource)}],`
        + '{stdio:"ignore"});',
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));`,
      'setInterval(()=>{},1000);',
    ].join('');

    try {
      const result = await runResult(process.execPath, ['-e', parentSource], {
        maxOutputBytes: 8 * 1024,
        terminationGraceMs: 100,
        timeoutMs: 250,
      });
      expect(result.status).toBeNull();
      const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch (error: any) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(temporary, { force: true, recursive: true });
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'bounds subprocess %s and terminates an output flood',
    async (stream) => {
      const source = [
        'process.on("SIGTERM",()=>{});',
        'const block="x".repeat(65536);',
        `setInterval(()=>process.${stream}.write(block),0);`,
      ].join('');
      const result = await runResult(process.execPath, ['-e', source], {
        maxOutputBytes: 4_096,
        terminationGraceMs: 100,
        timeoutMs: 2_000,
      });

      expect(result.status).toBeNull();
      expect(Buffer.byteLength(result[stream])).toBeLessThanOrEqual(
        stream === 'stderr' ? 4_192 : 4_096
      );
      expect(result.stderr).toContain(`${stream} exceeded 4096 bytes`);
    }
  );

  it('does not inherit repository, registry, or home credentials by default', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'repository-secret');
    vi.stubEnv('NODE_AUTH_TOKEN', 'npm-secret');
    vi.stubEnv('DOCKER_CONFIG', '/private/docker');
    try {
      const result = await runResult(process.execPath, [
        '-e',
        'process.stdout.write(JSON.stringify({'
          + 'docker:process.env.DOCKER_CONFIG,'
          + 'github:process.env.GITHUB_TOKEN,'
          + 'home:process.env.HOME,'
          + 'npm:process.env.NODE_AUTH_TOKEN'
          + '}))',
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('monotonically advances npm tags and settles lost tag responses', async () => {
    const tags: Record<string, string> = {
      latest: '2.0.1',
      'vv-release-31186721be50d1033545dfeee9d6ee118b54fb1b974ea909ab2e960e0b7c049b':
        '2.0.2',
    };
    const addTag = vi.fn(async (tag: string) => {
      tags[tag] = '2.0.2';
      throw new Error('response lost after dist-tag add');
    });
    const removeTag = vi.fn(async (tag: string) => {
      delete tags[tag];
      throw new Error('response lost after dist-tag rm');
    });

    await reconcileNpmDistTags({
      addTag,
      expectedVersion: '2.0.2',
      getTags: async () => ({ ...tags }),
      removeTag,
      settleOptions: { attempts: 2, sleep: async () => undefined },
    });

    expect(tags).toEqual({ latest: '2.0.2' });
    expect(addTag).toHaveBeenCalledTimes(1);
    expect(removeTag).toHaveBeenCalledTimes(1);
  });

  it('gives npm tag promotion and cleanup their full independent propagation windows', async () => {
    const temporary = npmReleaseTags('2.1.0').temporary;
    let phase = 'initial';
    let observations = 0;
    const addTag = vi.fn(async () => { phase = 'promoting'; observations = 0; });
    const removeTag = vi.fn(async () => { phase = 'cleaning'; observations = 0; });
    const sleep = vi.fn(async () => undefined);
    await reconcileNpmDistTags({
      expectedVersion: '2.1.0',
      getTags: async () => {
        observations += 1;
        if (phase === 'initial' || (phase === 'promoting' && observations < 100)) {
          return { latest: '2.0.1', [temporary]: '2.1.0' };
        }
        if (phase !== 'cleaning' || observations < 100) {
          return { latest: '2.1.0', [temporary]: '2.1.0' };
        }
        return { latest: '2.1.0' };
      },
      addTag,
      removeTag,
      settleOptions: { sleep },
    });
    expect(addTag).toHaveBeenCalledTimes(1);
    expect(removeTag).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(198);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('never regresses a newer npm target tag', async () => {
    const tags: Record<string, string> = {
      latest: '2.1.0',
      'vv-release-31186721be50d1033545dfeee9d6ee118b54fb1b974ea909ab2e960e0b7c049b':
        '2.0.2',
    };
    const addTag = vi.fn();
    const removeTag = vi.fn(async (tag: string) => {
      delete tags[tag];
    });

    await reconcileNpmDistTags({
      addTag,
      expectedVersion: '2.0.2',
      getTags: async () => ({ ...tags }),
      removeTag,
      settleOptions: { attempts: 2, sleep: async () => undefined },
    });

    expect(tags.latest).toBe('2.1.0');
    expect(addTag).not.toHaveBeenCalled();
    expect(removeTag).toHaveBeenCalledTimes(1);
  });

  it('always includes deleted MCP versions in authoritative lifecycle reads', () => {
    expect(mcpVersionUrl(
      {
        name: 'io.github.VectorMethods/videovector-mcp-server',
        version: '2.0.2',
      },
      'https://registry.modelcontextprotocol.io/'
    )).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers/'
      + 'io.github.VectorMethods%2Fvideovector-mcp-server/versions/'
      + '2.0.2?include_deleted=true'
    );
  });

  it('keeps the workflow package-global and delegates mutations to one engine', () => {
    const workflow = fs.readFileSync(
      path.join(sourceRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    expect(workflow).toContain('group: release-videovector-mcp-server');
    expect(workflow).not.toMatch(/\bnpm publish\b/);
    expect(workflow).not.toMatch(/\bskopeo\s+copy\b/);
    expect(workflow.match(/release-publication\.mjs publish-/g)).toHaveLength(2);

    const npmJob = workflow.split('\n  publish-npm:')[1]
      .split('\n  publish-mcp-registry:')[0];
    const mcpJob = workflow.split('\n  publish-mcp-registry:')[1];
    expect(npmJob.indexOf('Verify request-bound bundle')).toBeLessThan(
      npmJob.indexOf('Install checksum-pinned OIDC dist-tag publisher')
    );
    expect(npmJob.indexOf('Install checksum-pinned OIDC dist-tag publisher')).toBeLessThan(
      npmJob.indexOf('Reconcile npm version and monotonic dist-tags')
    );
    expect(npmJob).toContain('bash scripts/install_pinned_npm.sh publisher');
    expect(npmJob).toContain('timeout-minutes: 40');
    expect(workflow).not.toMatch(/ghcr|oci-archive|packages: write|docker login|bootstrap_ghcr/i);
    expect(mcpJob).toContain('      - publish-npm');
    expect(mcpJob.indexOf('Verify request-bound bundle')).toBeLessThan(
      mcpJob.indexOf('Install checksum-pinned MCP publisher')
    );
    expect(
      workflow.match(/bash scripts\/install_pinned_npm\.sh/g)
    ).toHaveLength(6);
    expect(workflow).toContain('MCP_PUBLISHER_SHA256:');
    expect(workflow.match(/timeout 20s/g).length).toBeGreaterThanOrEqual(1);
    expect(workflow.match(/scripts\/validate-stdio-smoke\.mjs/g)).toHaveLength(1);
    expect(workflow.match(/artifacts\/tool-contract\.json/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/tools\.result\.tools\.length\s*!==\s*48/);
    const npmInstaller = fs.readFileSync(
      path.join(sourceRoot, 'scripts/install_pinned_npm.sh'),
      'utf8'
    );
    expect(npmInstaller).toContain('npm_version="11.15.0"');
    expect(npmInstaller).toContain('npm_version="11.21.0"');
    expect(npmInstaller).toContain(
      '783e7c92bf73b442fb800c2d6ef3921e86da8894a700fed45140e37916877482'
    );
    expect(npmInstaller).toContain(
      'c15ed81d98f5f4c45e30f71e5dcf83ae24e9af5beb5db8b1d58becea97ba38cc'
    );
    const ciWorkflow = fs.readFileSync(
      path.join(sourceRoot, '.github/workflows/ci.yml'),
      'utf8'
    );
    expect(
      ciWorkflow.match(/bash scripts\/install_pinned_npm\.sh/g)
    ).toHaveLength(2);
    expect(ciWorkflow).toContain(
      'actionlint_1.7.12_linux_amd64.tar.gz'
    );
    expect(ciWorkflow).toContain(
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
    );
    expect(ciWorkflow).toContain(
      'shellcheck scripts/install_pinned_npm.sh scripts/validate_release_request.sh'
    );
    expect(ciWorkflow).toContain('timeout 20s docker run --rm -i');
  });
});
