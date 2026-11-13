/**
 * The local provider's environment builds (`FactorySandbox.builds`), so the
 * `factory-environment-build` workflow, its triggers (Build now, cron, push)
 * and the environment UI work for the local sandbox as they do for remote
 * templates (ADR-0039).
 *
 * A build refreshes the mirror of every environment repository, checks that
 * the pinned commit is in it, checks the commit out in a template copy
 * (`templates/<project>/<repo>`) and runs the setup commands there with the
 * shared package stores, so a session's install finds its packages locally.
 * It runs in the background of this process; its record
 * (`builds/<project>/<buildId>.json`) carries status, timing, error and a log
 * line per repository, and a heartbeat: a `building` record whose heartbeat
 * stopped (the server died mid-build) reads as `unknown`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FactorySandboxBuild,
  FactorySandboxBuildStart,
  FactorySandboxBuilds,
  FactorySandboxContext,
} from '@mastra/core/workspace';

import type { ExecutableSandbox } from '../materialization.ts';
import { gitAuthenticationEnvironment, normalizedRemoteUrl, runSandboxCommand, runSetupCommand } from '../github/sandbox.ts';
import { buildEnvOf, maskSandboxEnvValues } from '../sandbox-env.ts';
import { repositoryDirectoryName, sanitizeSegment } from '../workdir.ts';
import type { LocalMirrorLogger, LocalMirrorRepositoryCache } from './local-mirror-cache.ts';

const BUILD_SESSION_PREFIX = 'environment-build:';
const HISTORY = 20;
const BUILD_ID = /^local-[a-z0-9]+-[a-f0-9]{8}$/;
export const DEFAULT_BUILD_HEARTBEAT_MS = 60_000;
export const DEFAULT_BUILD_STALE_MS = 3 * 60_000;

interface BuildRecord extends FactorySandboxBuild {
  heartbeatAt?: string;
}

export interface LocalEnvironmentBuildsOptions {
  /** The template root: records under `builds/`, template copies under `templates/`. */
  root: string;
  cache: LocalMirrorRepositoryCache;
  /** Runs setup commands and template git on the server host, with the sandbox environment and package stores. */
  host: ExecutableSandbox;
  logger: LocalMirrorLogger;
  now?: () => number;
  heartbeatMs?: number;
  staleMs?: number;
  /** Mirrors no project names are removed after this long unused. */
  pruneIdleMs?: number;
}

/** `owner/repo` of a clone URL, for logs and directory names. */
export function repositorySlug(cloneUrl: string): string {
  const normalized = normalizedRemoteUrl(cloneUrl);
  const parts = (normalized ? new URL(normalized).pathname : cloneUrl).replace(/\.git$/i, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || 'repo';
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export class LocalEnvironmentBuilds implements FactorySandboxBuilds<Record<string, never>> {
  readonly #options: LocalEnvironmentBuildsOptions;
  readonly #running = new Map<string, Promise<void>>();
  readonly #now: () => number;

  constructor(options: LocalEnvironmentBuildsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Builds still running in this process; tests and shutdown await them. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  #projectKey(ctx: FactorySandboxContext): string {
    const id = ctx.sessionId.startsWith(BUILD_SESSION_PREFIX) ? ctx.sessionId.slice(BUILD_SESSION_PREFIX.length) : ctx.sessionId;
    return sanitizeSegment(id);
  }

  #dir(project: string): string {
    return path.join(this.#options.root, 'builds', project);
  }

  async #write(project: string, record: BuildRecord): Promise<void> {
    const dir = this.#dir(project);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.buildId}.json`);
    const temporary = `${file}.${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2));
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #read(project: string, buildId: string): Promise<BuildRecord | undefined> {
    if (!BUILD_ID.test(buildId)) return undefined;
    try {
      return JSON.parse(await readFile(path.join(this.#dir(project), `${buildId}.json`), 'utf8')) as BuildRecord;
    } catch {
      return undefined;
    }
  }

  /** A `building` record nobody in this process runs and whose heartbeat stopped is a build that died. */
  #view(record: BuildRecord): FactorySandboxBuild {
    const { heartbeatAt, ...build } = record;
    if (
      (build.status === 'building' || build.status === 'pending') &&
      !this.#running.has(build.buildId) &&
      this.#now() - Date.parse(heartbeatAt ?? build.startedAt ?? '0') > (this.#options.staleMs ?? DEFAULT_BUILD_STALE_MS)
    ) {
      return { ...build, status: 'unknown', error: 'The build stopped without finishing (the server restarted or the build died).' };
    }
    return build;
  }

  async start(ctx: FactorySandboxContext): Promise<FactorySandboxBuildStart> {
    const project = this.#projectKey(ctx);
    const buildId = `local-${this.#now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const templateId = `local:${project}`;
    const startedAt = new Date(this.#now()).toISOString();
    const record: BuildRecord = { buildId, status: 'building', templateId, startedAt, heartbeatAt: startedAt, logs: [] };
    await this.#write(project, record);
    const run = this.#run(ctx, project, record).finally(() => this.#running.delete(buildId));
    this.#running.set(buildId, run);
    return { buildId, status: 'building', templateId };
  }

  async get(ctx: FactorySandboxContext, _settings: Record<string, never>, buildId: string): Promise<FactorySandboxBuild> {
    const record = await this.#read(this.#projectKey(ctx), buildId);
    return record ? this.#view(record) : { buildId, status: 'unknown' };
  }

  async list(ctx: FactorySandboxContext): Promise<FactorySandboxBuild[]> {
    const dir = this.#dir(this.#projectKey(ctx));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const records: BuildRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !BUILD_ID.test(name.slice(0, -5))) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(dir, name), 'utf8')) as BuildRecord);
      } catch {
        // A record half-written by a crash is skipped.
      }
    }
    return records
      .sort((a, b) => Date.parse(b.startedAt ?? '0') - Date.parse(a.startedAt ?? '0'))
      .slice(0, HISTORY)
      .map(record => this.#view(record));
  }

  async #run(ctx: FactorySandboxContext, project: string, record: BuildRecord): Promise<void> {
    const { cache, host, logger } = this.#options;
    const logs: string[] = [];
    const mask = (text: string) => maskSandboxEnvValues(text, buildEnvOf(ctx));
    const log = (line: string) => {
      logs.push(mask(line));
    };
    // The last heartbeat write is awaited before the final one, so it can never land after it.
    let beat: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      beat = this.#write(project, { ...record, logs: [...logs], heartbeatAt: new Date(this.#now()).toISOString() }).catch(() => {});
    }, this.#options.heartbeatMs ?? DEFAULT_BUILD_HEARTBEAT_MS);
    heartbeat.unref?.();
    const started = this.#now();
    let fatal: string | undefined;
    const setupFailures: string[] = [];
    try {
      const repos =
        ctx.repos ??
        (ctx.getRepositoryAccess ? [{ getRepositoryAccess: ctx.getRepositoryAccess, setupCommand: ctx.setupCommand }] : []);
      const templateRoot = path.join(this.#options.root, 'templates', project);
      const cloneUrls: string[] = [];
      for (const repo of repos) {
        const repoStarted = this.#now();
        let slug = 'repository';
        try {
          const access = await repo.getRepositoryAccess();
          const cloneUrl = access.cloneUrl;
          slug = repositorySlug(cloneUrl);
          cloneUrls.push(cloneUrl);
          const token = access.authorization?.token;
          const authEnv =
            token && /^https:/i.test(cloneUrl)
              ? gitAuthenticationEnvironment(cloneUrl, token, access.authorization?.username ?? 'x-access-token')
              : undefined;
          const refreshed = await cache.refresh({ cloneUrl, ...(authEnv ? { authEnv } : {}) });
          const head = await ctx.resolveHead?.(cloneUrl, token);
          if (head && !(await cache.hasCommit(cloneUrl, head))) {
            throw new Error(`the pinned commit ${head} is not in the mirror after the fetch`);
          }
          log(
            `${slug}: mirror ${refreshed.created ? 'created' : 'fetched'} in ${seconds(refreshed.durationMs)}` +
              (refreshed.lockWaitMs > 1000 ? ` (waited ${seconds(refreshed.lockWaitMs)} for the lock)` : '') +
              (head ? ` · ${head.slice(0, 12)}` : ''),
          );
          if (!head) {
            log(`${slug}: no pinned commit; setup skipped`);
            continue;
          }
          const dir = path.join(templateRoot, repositoryDirectoryName(slug));
          await cache.withReader(cloneUrl, () => this.#checkoutTemplate(cache.mirrorPath(cloneUrl), dir, head));
          const commands = repo.setupCommand === undefined ? [] : Array.isArray(repo.setupCommand) ? repo.setupCommand : [repo.setupCommand];
          for (const command of commands.filter(command => command.trim())) {
            const setupStarted = this.#now();
            try {
              await runSetupCommand(host, dir, command, buildEnvOf(ctx));
              log(`${slug}: setup done in ${seconds(this.#now() - setupStarted)}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setupFailures.push(slug);
              log(`${slug}: setup failed — ${message}`);
              if (!ctx.continueOnSetupFailure) throw error;
            }
          }
          log(`${slug}: ready in ${seconds(this.#now() - repoStarted)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`${slug}: failed — ${message}`);
          fatal ??= `${slug}: ${message}`;
        }
      }
      await this.#writeManifest(project, cloneUrls);
      const workspaceCommands =
        ctx.workspaceSetupCommand === undefined
          ? []
          : Array.isArray(ctx.workspaceSetupCommand)
            ? ctx.workspaceSetupCommand
            : [ctx.workspaceSetupCommand];
      if (!fatal) {
        for (const command of workspaceCommands.filter(command => command.trim())) {
          try {
            await mkdir(templateRoot, { recursive: true });
            await runSetupCommand(host, templateRoot, command, buildEnvOf(ctx));
            log('workspace setup done');
          } catch (error) {
            fatal = `workspace setup: ${error instanceof Error ? error.message : String(error)}`;
            log(`workspace setup failed — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      // Housekeeping rides on builds: pack the mirrors this project uses, drop the ones nobody uses.
      for (const cloneUrl of cloneUrls) await cache.maintain(cloneUrl);
      const removed = await cache.prune(await this.#allManifestUrls(), {
        ...(this.#options.pruneIdleMs !== undefined ? { idleMs: this.#options.pruneIdleMs } : {}),
      });
      if (removed.length) log(`removed ${removed.length} unused mirror(s)`);
    } catch (error) {
      fatal ??= error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(heartbeat);
      await beat;
    }
    log(`${fatal ? 'failed' : 'ready'} in ${seconds(this.#now() - started)}${setupFailures.length ? ` · setup failed: ${setupFailures.join(', ')}` : ''}`);
    const finished: BuildRecord = {
      ...record,
      status: fatal ? 'failed' : 'ready',
      finishedAt: new Date(this.#now()).toISOString(),
      heartbeatAt: new Date(this.#now()).toISOString(),
      logs,
      ...(fatal ? { error: mask(fatal) } : {}),
    };
    try {
      await this.#write(project, finished);
      await this.#trimHistory(project);
    } catch (error) {
      logger.warn('could not record the environment build', { project, buildId: record.buildId, error: String(error) });
    }
    logger.info(`environment build ${finished.status}`, { project, buildId: record.buildId, ms: this.#now() - started });
  }

  /** The template copy at `head`, from the mirror; never touches the network. */
  async #checkoutTemplate(mirror: string, dir: string, head: string): Promise<void> {
    const { host } = this.#options;
    const exists = await stat(path.join(dir, '.git')).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      const clone = await runSandboxCommand(host, 'git', ['clone', '--local', '--quiet', '--no-checkout', '--', mirror, dir], { timeoutMs: 10 * 60_000 });
      if (clone.exitCode !== 0) throw new Error(`template clone failed: ${clone.stderr.trim().slice(-1000)}`);
    } else {
      const fetch = await runSandboxCommand(host, 'git', ['-C', dir, 'fetch', '--quiet', '--no-tags', mirror, head], { timeoutMs: 10 * 60_000 });
      if (fetch.exitCode !== 0) throw new Error(`template fetch failed: ${fetch.stderr.trim().slice(-1000)}`);
    }
    const checkout = await runSandboxCommand(host, 'git', ['-C', dir, 'checkout', '--quiet', '--force', '--detach', head], { timeoutMs: 10 * 60_000 });
    if (checkout.exitCode !== 0) throw new Error(`template checkout failed: ${checkout.stderr.trim().slice(-1000)}`);
  }

  async #writeManifest(project: string, cloneUrls: string[]): Promise<void> {
    const dir = this.#dir(project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'repos.json'), JSON.stringify({ cloneUrls, at: new Date(this.#now()).toISOString() }));
  }

  /** Every repository any project's last build named: the mirrors housekeeping keeps. */
  async #allManifestUrls(): Promise<string[]> {
    const root = path.join(this.#options.root, 'builds');
    const urls: string[] = [];
    let projects: string[] = [];
    try {
      projects = await readdir(root);
    } catch {
      return urls;
    }
    for (const project of projects) {
      try {
        const manifest = JSON.parse(await readFile(path.join(root, project, 'repos.json'), 'utf8')) as { cloneUrls?: string[] };
        urls.push(...(manifest.cloneUrls ?? []));
      } catch {
        // A project that never finished a build names nothing.
      }
    }
    return urls;
  }

  async #trimHistory(project: string): Promise<void> {
    const dir = this.#dir(project);
    const names = (await readdir(dir)).filter(name => name.endsWith('.json') && BUILD_ID.test(name.slice(0, -5)));
    if (names.length <= HISTORY * 2) return;
    const dated = await Promise.all(
      names.map(async name => ({ name, at: (await stat(path.join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    for (const { name } of dated.sort((a, b) => b.at - a.at).slice(HISTORY * 2)) {
      await rm(path.join(dir, name), { force: true });
    }
  }
}
