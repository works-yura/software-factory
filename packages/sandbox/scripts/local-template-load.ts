/**
 * Load test for the local environment template (ADR-0039); not part of CI.
 *
 *   node --experimental-strip-types packages/sandbox/scripts/local-template-load.ts \
 *     [--dir <scratch dir on the sandboxes' volume>] [--sessions 15] [--repos 5] [--source <git dir of a real repo>]
 *
 * Builds N bare "remote" repositories (or uses `--source` as one realistic
 * repository), measures a network-style clone (`git clone --depth=1
 * file://…`, the pack transport a GitHub clone uses, minus the internet) and
 * a mirror clone, then materializes `--sessions` sessions in parallel, each
 * checking out every repository from the mirrors: wall time, per-checkout
 * time, lock waits, disk use (hard links counted once) and `git fsck` of
 * every mirror and every session clone.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hostExecutor } from '../src/template/host-exec.ts';
import { LocalMirrorRepositoryCache } from '../src/template/local-mirror-cache.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const sessions = Number(arg('sessions', '15'));
const repoCount = Number(arg('repos', '5'));
const source = arg('source', '');
const base = await mkdtemp(path.join(path.resolve(arg('dir', tmpdir())), 'factory-template-load-'));
const env = {
  HOME: base,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Load',
  GIT_AUTHOR_EMAIL: 'load@example.com',
  GIT_COMMITTER_NAME: 'Load',
  GIT_COMMITTER_EMAIL: 'load@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const timed = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
};
const duKb = (...dirs: string[]) => Number(execFileSync('du', ['-sk', ...dirs], { encoding: 'utf8' }).trim().split('\n').at(-1)!.split('\t')[0]);
const duSeparateKb = (dirs: string[]) => dirs.reduce((sum, dir) => sum + duKb(dir), 0);

try {
  // Remotes: synthetic repositories with some history, or one real repository.
  const origins: string[] = [];
  if (source) {
    const origin = path.join(base, 'origins', 'source.git');
    await mkdir(path.dirname(origin), { recursive: true });
    git(base, 'clone', '--quiet', '--bare', '--no-local', source, origin);
    origins.push(origin);
  } else {
    for (let r = 0; r < repoCount; r++) {
      const seed = path.join(base, 'seeds', `repo-${r}`);
      await mkdir(seed, { recursive: true });
      git(seed, 'init', '--quiet', '--initial-branch=main');
      for (let c = 0; c < 20; c++) {
        for (let f = 0; f < 40; f++) {
          await writeFile(path.join(seed, `file-${f}.txt`), `${'x'.repeat(2000)} ${r} ${c} ${f} ${Math.random()}\n`.repeat(5));
        }
        git(seed, 'add', '--all');
        git(seed, 'commit', '--quiet', '-m', `commit ${c}`);
      }
      const origin = path.join(base, 'origins', `repo-${r}.git`);
      git(base, 'clone', '--quiet', '--bare', seed, origin);
      origins.push(origin);
    }
  }
  const urls = origins.map(origin => `file://${origin}`);
  const branchOf = (origin: string) => git(origin, 'symbolic-ref', '--short', 'HEAD');

  // Network-style clone (pack transport) vs mirror clone, one repository at a time.
  const network: number[] = [];
  for (const [i, url] of urls.entries()) {
    const dir = path.join(base, 'network', `r${i}`);
    const [, ms] = await timed(() => git(base, 'clone', '--quiet', '--depth=1', '--single-branch', '--branch', branchOf(origins[i]!), url, dir));
    network.push(ms);
  }

  const cache = new LocalMirrorRepositoryCache({ root: path.join(base, 'template'), host: hostExecutor({ env }), logger: { info() {}, warn() {} } });
  const mirrorCreate: number[] = [];
  for (const url of urls) {
    const [, ms] = await timed(() => cache.refresh({ cloneUrl: url }));
    mirrorCreate.push(ms);
  }

  const host = hostExecutor({ env });
  const single: number[] = [];
  for (const [i, url] of urls.entries()) {
    const dir = path.join(base, 'single', `r${i}`);
    await mkdir(dir, { recursive: true });
    const [result, ms] = await timed(() => cache.checkout(host, { cloneUrl: url }, { workdir: dir, branch: branchOf(origins[i]!) }));
    if (result.source !== 'mirror') throw new Error(`single checkout fell back: ${JSON.stringify(result)}`);
    single.push(ms);
  }

  // Parallel sessions, each with every repository.
  const sessionDirs: string[] = [];
  const perCheckout: number[] = [];
  const lockWaits: number[] = [];
  const [, wall] = await timed(() =>
    Promise.all(
      Array.from({ length: sessions }, async (_, s) => {
        const folder = path.join(base, 'sandboxes', `session-${s}`);
        sessionDirs.push(folder);
        await Promise.all(
          urls.map(async (url, i) => {
            const dir = path.join(folder, `r${i}`);
            await mkdir(dir, { recursive: true });
            const [result, ms] = await timed(() => cache.checkout(host, { cloneUrl: url }, { workdir: dir, branch: branchOf(origins[i]!) }));
            if (result.source !== 'mirror') throw new Error(`session ${s} repo ${i} fell back: ${JSON.stringify(result)}`);
            perCheckout.push(ms);
            lockWaits.push(result.lockWaitMs);
          }),
        );
      }),
    ),
  );

  // Soundness: every mirror and every session clone passes fsck.
  let fsckFailures = 0;
  for (const url of urls) {
    try {
      git(base, '-C', cache.mirrorPath(url), 'fsck', '--connectivity-only', '--no-progress');
    } catch {
      fsckFailures++;
    }
  }
  for (const folder of sessionDirs) {
    for (let i = 0; i < urls.length; i++) {
      try {
        git(base, '-C', path.join(folder, `r${i}`), 'fsck', '--connectivity-only', '--no-progress');
      } catch {
        fsckFailures++;
      }
    }
  }

  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    return { min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) };
  };
  const report = {
    volume: base,
    repositories: urls.length,
    sessions,
    repoSizeKb: origins.map(origin => duKb(origin)),
    networkStyleCloneMs: network.map(Math.round),
    mirrorCreateMs: mirrorCreate.map(Math.round),
    singleMirrorCheckoutMs: single.map(Math.round),
    parallel: {
      wallMs: Math.round(wall),
      checkouts: perCheckout.length,
      perCheckoutMs: stats(perCheckout),
      lockWaitMs: stats(lockWaits),
    },
    diskKb: {
      sessionsCountedOnce: duKb(path.join(base, 'sandboxes')),
      sessionsCountedSeparately: duSeparateKb(sessionDirs),
      mirrors: duKb(path.join(base, 'template', 'mirrors')),
    },
    fsckFailures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (fsckFailures) process.exitCode = 1;
} finally {
  if (!process.argv.includes('--keep')) await rm(base, { recursive: true, force: true });
}
