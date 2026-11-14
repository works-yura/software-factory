import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FactorySandboxContext } from '@mastra/core/workspace';

import { LocalEnvironmentTemplate } from './local-template.ts';
import { gitFixture, mirrorsOf } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };

describe('local environment builds, with real git', () => {
  let fx: GitFixture;
  let template: LocalEnvironmentTemplate;
  let root: string;

  const context = (overrides: Partial<FactorySandboxContext> = {}): FactorySandboxContext => ({
    sessionId: 'environment-build:project-1',
    getRepositoryAccess: undefined,
    repos: [
      {
        getRepositoryAccess: async () => ({ cloneUrl: fx.origin }),
        setupCommand: 'printf "%s" "$npm_config_store_dir|$npm_config_package_import_method|$BUILD_ONLY" > setup-ran.txt',
      },
    ],
    continueOnSetupFailure: true,
    resolveHead: async () => fx.git(fx.seed, 'rev-parse', 'HEAD'),
    ...overrides,
  });
  const settle = async () => {
    await template.builds!.settled();
    await mirrorsOf(template).settled();
  };

  beforeEach(async () => {
    fx = await gitFixture('factory-builds-');
    root = path.join(fx.root, 'template');
    template = new LocalEnvironmentTemplate({ root, env: fx.env, logger: silent, freshnessMs: 0, packageStores: true });
  });

  afterEach(async () => {
    await settle();
    await rm(fx.root, { recursive: true, force: true });
  });

  it('builds: mirror at the pinned commit, setup in a template copy with the shared package stores, recorded with timing', async () => {
    const head = fx.git(fx.seed, 'rev-parse', 'HEAD');
    const ctx = { ...context(), buildEnv: { BUILD_ONLY: 'secret-value' } } as FactorySandboxContext;
    const started = await template.builds!.start(ctx);
    expect(started).toMatchObject({ status: 'building', templateId: 'local:project-1' });
    expect((await template.builds!.get(ctx, {}, started.buildId)).status).toBe('building');
    await settle();

    const build = await template.builds!.get(ctx, {}, started.buildId);
    expect(build.status).toBe('ready');
    expect(build.finishedAt).toBeTruthy();
    expect(build.logs?.join('\n')).toContain(head.slice(0, 12));
    expect(build.logs?.join('\n')).toMatch(/mirror created in [\d.]+ s/);
    const ran = await readFile(path.join(root, 'templates', 'project-1', 'origin.git', 'setup-ran.txt'), 'utf8').catch(async () =>
      readFile(path.join(root, 'templates', 'project-1', 'origin', 'setup-ran.txt'), 'utf8'),
    );
    expect(ran).toBe(`${path.join(root, 'package-stores', 'pnpm')}|clone-or-copy|secret-value`);
    expect(await mirrorsOf(template).hasCommit(fx.origin, head)).toBe(true);
    // History lists it, newest first.
    const second = await template.builds!.start(ctx);
    await settle();
    const history = await template.builds!.list(ctx);
    expect(history.map(entry => entry.buildId)).toEqual([second.buildId, started.buildId]);
    expect(history[0]?.logs?.join('\n')).toMatch(/mirror fetched/);
  });

  it('records a failing setup and stays ready (continueOnSetupFailure), masking Build values', async () => {
    const ctx = {
      ...context({ repos: [{ getRepositoryAccess: async () => ({ cloneUrl: fx.origin }), setupCommand: 'echo "leak secret-value" >&2; exit 3' }] }),
      buildEnv: { BUILD_ONLY: 'secret-value' },
    } as FactorySandboxContext;
    const started = await template.builds!.start(ctx);
    await settle();
    const build = await template.builds!.get(ctx, {}, started.buildId);
    expect(build.status).toBe('ready');
    const logs = build.logs?.join('\n') ?? '';
    expect(logs).toMatch(/setup failed/);
    expect(logs).not.toContain('secret-value');
  });

  it('fails when the pinned commit is not in the remote, or the remote cannot be reached', async () => {
    const pinned = await template.builds!.start(context({ resolveHead: async () => 'f'.repeat(40) }));
    await settle();
    const missing = await template.builds!.get(context(), {}, pinned.buildId);
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatch(/pinned commit/);

    const unreachable = await template.builds!.start(
      context({ repos: [{ getRepositoryAccess: async () => ({ cloneUrl: path.join(fx.root, 'gone.git') }) }] }),
    );
    await settle();
    expect((await template.builds!.get(context(), {}, unreachable.buildId)).status).toBe('failed');
  });

  it('reads a build whose heartbeat stopped (server died mid-build) as unknown', async () => {
    const dir = path.join(root, 'builds', 'project-1');
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(
      path.join(dir, 'local-abc-0123abcd.json'),
      JSON.stringify({ buildId: 'local-abc-0123abcd', status: 'building', startedAt: old, heartbeatAt: old }),
    );
    const build = await template.builds!.get(context(), {}, 'local-abc-0123abcd');
    expect(build.status).toBe('unknown');
    expect(build.error).toMatch(/stopped without finishing/);
    // Ids that are not this provider's never reach the disk.
    expect((await template.builds!.get(context(), {}, '../../etc/passwd')).status).toBe('unknown');
  });
});
