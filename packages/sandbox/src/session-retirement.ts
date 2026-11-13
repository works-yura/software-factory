import { access } from 'node:fs/promises';

import type { FactorySandbox, WorkspaceSandbox } from '@mastra/core/workspace';

import { destroyDetachedSessionSandbox, releaseSessionSandbox } from './github/sandbox-release.ts';
import { DEFAULT_COMMAND_TIMEOUT_MS, runTeardownCommand } from './github/sandbox.ts';
import { peekSessionEnvironmentTeardown } from './environment-state-processor.ts';
import type {
  ProjectRepository,
  SourceControlSession,
  SourceControlStorageHandle,
} from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';
import { deleteSessionRecord } from '@factory/store';
import { LocalFactorySandbox } from './local-factory-sandbox.ts';
import { requireExec } from './materialization.ts';
import {
  clearFailedSetupCommands,
  evictSessionSandbox,
  peekSessionSandbox,
  peekWorkItemFolderSessions,
  withWorkItemFolderLock,
} from './session-sandbox.ts';
import type { WorkItemFolder, WorkItemFolders } from './work-item-folder.ts';

type WarningLogger = (message: string, details: Record<string, unknown>) => void;

/** A session's sandbox and recorded teardown, captured before its retirement drops them. */
interface CapturedTeardown {
  session: SourceControlSession;
  entry: ReturnType<typeof peekSessionSandbox>;
  environment: ReturnType<typeof peekSessionEnvironmentTeardown>;
}

export interface SessionRetirementCoordinatorOptions {
  invalidateSession?: (sessionId: string) => Promise<void> | void;
  /** Told after a session's row is deleted, to drop what else the host keeps for it (a CLI config dir, say). */
  onSessionDeleted?: (sessionId: string) => Promise<void> | void;
  /**
   * The deploy's sandbox configuration. Used to destroy a deleted session's
   * VM by identity when this process never attached to it (after a restart,
   * or on another replica). Recreate uses it the same way.
   */
  sandbox?: FactorySandbox;
  warn?: WarningLogger;
  /** How long recreate waits on a started sandbox's lifecycle destroy before falling back. */
  destroyTimeoutMs?: number;
  /**
   * Where the sessions of a card work. A session in its card's shared folder
   * is only stopped when it retires; the folder goes when the card reaches its
   * terminal stage or is deleted, or when its last session is deleted. Without
   * it every session has a folder of its own.
   */
  workItemFolders?: WorkItemFolders;
}

export interface RecreateSessionSandboxInput {
  sourceControl: SourceControlStorageHandle;
  orgId: string;
  sessionId: string;
}

const DEFAULT_DESTROY_TIMEOUT_MS = 30_000;

/**
 * A provider error meaning the VM is already gone: 410, or a 404 the proxy
 * marks `not_found` (or leaves uncoded). A routing 404 with another code is
 * not proof the VM is gone.
 */
function isSandboxGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (status === 410) return true;
  return status === 404 && (code === undefined || code === null || code === 'not_found');
}

export interface RetireSessionInput {
  sourceControl: SourceControlStorageHandle;
  /** When provided, deleting the session row also strips its work-item refs and revokes its run bindings (`deleteSessionRecord`). */
  workItems?: Pick<WorkItemsStorage, 'clearSessionReferences'>;
  orgId: string;
  sessionId: string;
  deleteSession: boolean;
}

function boundedError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.length <= 2000) return detail;
  return `${detail.slice(0, 200)}...${detail.slice(-1797)}`;
}

/**
 * Owns terminal and destructive session cleanup. Each session is serialized so
 * duplicate role bindings and competing deletion/transition requests cannot
 * run teardown concurrently.
 *
 * Sandbox identity is the session id: retirement stops (or, for deleted
 * sessions, destroys) the sandbox this process holds in the session memo.
 * Sessions opened on another replica (or before a restart) have no memo entry
 * here: stopping them is left to the provider's idle lifecycle, but deleting a
 * materialized session destroys its VM by identity through the configured
 * sandbox. Providers such as E2B keep paused VMs forever, so the row's
 * deletion must never orphan one.
 */
export class SessionRetirementCoordinator {
  readonly #invalidateSession: NonNullable<SessionRetirementCoordinatorOptions['invalidateSession']>;
  readonly #onSessionDeleted: SessionRetirementCoordinatorOptions['onSessionDeleted'];
  readonly #sandbox: FactorySandbox | undefined;
  readonly #warn: WarningLogger;
  readonly #destroyTimeoutMs: number;
  readonly #workItemFolders: WorkItemFolders | undefined;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: SessionRetirementCoordinatorOptions = {}) {
    this.#invalidateSession = options.invalidateSession ?? (() => {});
    this.#onSessionDeleted = options.onSessionDeleted;
    this.#sandbox = options.sandbox;
    this.#warn = options.warn ?? ((message, details) => console.warn(`[Factory] ${message}`, details));
    this.#destroyTimeoutMs = options.destroyTimeoutMs ?? DEFAULT_DESTROY_TIMEOUT_MS;
    this.#workItemFolders = options.workItemFolders;
  }

  async retireSession(input: RetireSessionInput): Promise<void> {
    await this.#withSessionLock(input.sessionId, () => this.#retireSession(input));
  }

  /**
   * Stop a session's sandbox without retiring the session: its row, branch and
   * files stay, and its next run starts the sandbox again (a local sandbox
   * reuses its folder). For a session in its card's shared folder this stops
   * only what this session runs there. A sandbox this process never opened is
   * left to its provider: the local provider keeps no identity to reach it by.
   */
  async stopSessionSandbox(input: Pick<RetireSessionInput, 'sessionId' | 'orgId' | 'sourceControl'>): Promise<void> {
    await this.#withSessionLock(input.sessionId, async () => {
      const session = await input.sourceControl.sessions.getBySessionId(input.sessionId);
      if (!session || session.orgId !== input.orgId) return;
      const entry = peekSessionSandbox(session.id);
      if (!entry) return;
      await this.#stopSandbox(session, entry.sandbox);
      await this.#invalidate(session);
    });
  }

  /**
   * Destroy a session's sandbox so its next message boots a fresh VM from the
   * template, keeping the session row, its conversation, and work-item refs.
   * Skips teardown commands, and works without a memo entry in this process
   * by destroying a detached instance built from the persisted `sandboxId`.
   * A destroy failure keeps the persisted id so a retry can reach the VM.
   */
  async recreateSessionSandbox(input: RecreateSessionSandboxInput): Promise<'recreated' | 'not-found'> {
    return this.#withSessionLock(input.sessionId, () => this.#recreateSessionSandbox(input));
  }

  /**
   * Replace the session's VM while keeping its sandbox instance, for the
   * session's own agent. A run holds the instance it started with until the
   * run ends, so recreate (which destroys the instance) would leave every
   * later command in that run failing. Here the VM is destroyed and the
   * instance is left `stopped` with no VM id, so the run's next command starts
   * a fresh VM and the start hook sets it up again.
   *
   * `not-here` means this process holds no instance for the session.
   */
  async resetSessionSandbox(input: RecreateSessionSandboxInput): Promise<'reset' | 'not-found' | 'not-here'> {
    return this.#withSessionLock(input.sessionId, () => this.#resetSessionSandbox(input));
  }

  async #withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.#locks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.#locks.get(sessionId) === current) this.#locks.delete(sessionId);
    }
  }

  /**
   * Retire every session of a card that is done (its terminal stage) or
   * deleted: the card's shared folders are torn down once each and removed,
   * then each session is retired. `sourceControl` is the handle every session
   * of the card resolves through, or a lookup per session. `folders` adds card
   * folders no listed session names (the card's own branch).
   */
  async retireWorkItemSessions(options: {
    workItems: Pick<WorkItemsStorage, 'get'>;
    sourceControl:
      | SourceControlStorageHandle
      | ((sessionId: string) => Promise<SourceControlStorageHandle | null | undefined>);
    orgId: string;
    workItemId: string;
    /** The card's sessions, when the card is already gone from storage. */
    sessionIds?: string[];
    folders?: WorkItemFolder[];
  }): Promise<void> {
    let sessionIds = options.sessionIds;
    if (!sessionIds) {
      const item = await options.workItems.get({ orgId: options.orgId, id: options.workItemId });
      if (!item) return;
      sessionIds = Object.values(item.sessions).map(session => session.sessionId);
    }
    const handleFor = async (sessionId: string) =>
      typeof options.sourceControl === 'function' ? await options.sourceControl(sessionId) : options.sourceControl;
    const sessions: Array<{ sourceControl: SourceControlStorageHandle; session: SourceControlSession }> = [];
    for (const sessionId of new Set(sessionIds)) {
      const sourceControl = await handleFor(sessionId);
      const session = await sourceControl?.sessions.getBySessionId(sessionId);
      if (sourceControl && session && session.orgId === options.orgId) sessions.push({ sourceControl, session });
    }

    const folders = new Map<string, WorkItemFolder>();
    for (const folder of options.folders ?? []) folders.set(folder.key, folder);
    for (const { session } of sessions) {
      try {
        const folder = peekSessionSandbox(session.id)?.folder ?? (await this.#folderOf(session));
        if (folder) folders.set(folder.key, folder);
      } catch (error) {
        this.#warn('Factory card folder of a session could not be resolved', {
          orgId: session.orgId,
          sessionId: session.sessionId,
          error: boundedError(error),
        });
      }
    }
    // Each folder once: its teardown commands run in it while a session's
    // sandbox can still run them, then its sessions stop and the folder goes.
    for (const folder of folders.values()) {
      const lead = sessions.find(({ session }) => peekSessionSandbox(session.id)?.folder?.key === folder.key);
      try {
        await this.#releaseFolder(
          folder,
          lead && { sourceControl: lead.sourceControl, teardown: this.#captureTeardown(lead.session) },
        );
      } catch (error) {
        this.#warn('Factory card folder release failed', { folder: folder.key, error: boundedError(error) });
      }
    }

    await Promise.all(
      sessions.map(({ sourceControl, session }) =>
        this.retireSession({ sourceControl, orgId: options.orgId, sessionId: session.sessionId, deleteSession: false }),
      ),
    );
  }

  async retireProjectRepositorySessions(options: {
    sourceControl: SourceControlStorageHandle;
    workItems?: Pick<WorkItemsStorage, 'clearSessionReferences'>;
    orgId: string;
    projectRepositoryId: string;
  }): Promise<void> {
    const sessions = await options.sourceControl.sessions.listByProjectRepository({
      projectRepositoryId: options.projectRepositoryId,
    });
    await Promise.all(
      sessions.map(session =>
        this.retireSession({
          sourceControl: options.sourceControl,
          ...(options.workItems ? { workItems: options.workItems } : {}),
          orgId: options.orgId,
          sessionId: session.sessionId,
          deleteSession: true,
        }),
      ),
    );
  }

  async #retireSession(input: RetireSessionInput): Promise<void> {
    const session = await input.sourceControl.sessions.getBySessionId(input.sessionId);
    if (!session || session.orgId !== input.orgId) return;

    // The folder its sandbox was built in wins over a fresh derivation: that is where its processes run.
    const memo = peekSessionSandbox(session.id);
    let folder = memo?.folder;
    // Saved work is forgotten only for a session known to work in a folder of its own.
    let folderResolved = true;
    try {
      folder ??= await this.#folderOf(session);
    } catch (error) {
      folderResolved = false;
      // A session whose card cannot be told apart still retires, as a session
      // of its own: no card folder is touched for it.
      this.#warn('Factory card folder of a session could not be resolved', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        error: boundedError(error),
      });
    }
    // Captured before invalidation, which drops the memo and the recorded environment.
    const teardown = folder ? this.#captureTeardown(session) : undefined;
    try {
      if (!folder) await this.#teardownSessionSandbox(input, session);
      // A card's folder outlives a retired session: only its sandbox stops.
      else if (!input.deleteSession) await this.#stopSandbox(session, teardown?.entry?.sandbox);
      // The folder it had of its own before cards shared one, unless it moved into the card's.
      if (folder && this.#sandbox instanceof LocalFactorySandbox) {
        await this.#sandbox.removeLegacySessionFolder(session.id).catch((error: unknown) =>
          this.#warn('Factory legacy session folder removal failed', {
            orgId: session.orgId,
            sessionId: session.sessionId,
            error: boundedError(error),
          }),
        );
      }
    } finally {
      await this.#invalidate(session);

      if (input.deleteSession) {
        await deleteSessionRecord({ sourceControl: input.sourceControl, workItems: input.workItems }, session);
        try {
          await this.#onSessionDeleted?.(session.sessionId);
        } catch (error) {
          this.#warn('Factory session cleanup after delete failed', {
            orgId: session.orgId,
            sessionId: session.sessionId,
            error: boundedError(error),
          });
        }
        if (folder) await this.#releaseFolderOfDeletedSession(input, session, folder, teardown!);
        // A session of its own discarded its branch's saved work with it; a
        // card's work stays for the card's other sessions until the card closes.
        else if (folderResolved && this.#sandbox instanceof LocalFactorySandbox) {
          await this.#sandbox.forgetSessionWork(session.id).catch((error: unknown) =>
            this.#warn('Factory saved session work could not be dropped', {
              orgId: session.orgId,
              sessionId: session.sessionId,
              error: boundedError(error),
            }),
          );
        }
      }
    }
  }

  /** The card folder the session works in, derived from the session and its card. */
  async #folderOf(session: SourceControlSession): Promise<WorkItemFolder | undefined> {
    if (!this.#workItemFolders) return undefined;
    return this.#workItemFolders.forSession({
      sessionId: session.sessionId,
      orgId: session.orgId,
      factoryProjectId: session.factoryProjectId,
      branch: session.branch,
    });
  }

  /** What tearing a session's folder down needs, read while this process still holds it. */
  #captureTeardown(session: SourceControlSession): CapturedTeardown {
    return {
      session,
      entry: peekSessionSandbox(session.id),
      environment: peekSessionEnvironmentTeardown(session.sessionId),
    };
  }

  /**
   * A session of a card's folder was deleted. Its row is gone, so when no
   * other session works in the folder (on the card branch, or bound to the
   * card) the folder goes too, torn down once; otherwise only its sandbox
   * stops. Checked under the folder's lock after the row is gone, so of
   * several sessions deleted at once the last one releases the folder.
   */
  async #releaseFolderOfDeletedSession(
    input: RetireSessionInput,
    session: SourceControlSession,
    folder: WorkItemFolder,
    teardown: CapturedTeardown,
  ): Promise<void> {
    try {
      await withWorkItemFolderLock(folder.key, async () => {
        if (await this.#folderHasOtherSessions(input, session, folder)) {
          await this.#stopSandbox(session, teardown.entry?.sandbox);
          return;
        }
        await this.#releaseFolderLocked(folder, { sourceControl: input.sourceControl, teardown });
      });
    } catch (error) {
      this.#warn('Factory card folder release failed', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        folder: folder.key,
        error: boundedError(error),
      });
    }
  }

  /** Whether a session other than `session` still works in `folder`: on the card branch, or bound to the card. */
  async #folderHasOtherSessions(
    input: RetireSessionInput,
    session: SourceControlSession,
    folder: WorkItemFolder,
  ): Promise<boolean> {
    const onBranch = await input.sourceControl.sessions.listByFactoryBranch({
      factoryProjectId: folder.factoryProjectId,
      branch: folder.branch,
    });
    if (onBranch.some(other => other.sessionId !== session.sessionId)) return true;
    const bound = (await this.#workItemFolders?.boundSessionIds({ orgId: input.orgId, folder })) ?? [];
    for (const sessionId of bound) {
      if (sessionId === session.sessionId) continue;
      const other = await input.sourceControl.sessions.getBySessionId(sessionId);
      // A session whose card cannot be resolved counts as still there: the folder is kept, never lost.
      if (other && (await this.#folderOf(other).catch(() => folder))?.key === folder.key) return true;
    }
    return false;
  }

  /** Tear a card's folder down once and remove it; see {@link #releaseFolderLocked}. */
  async #releaseFolder(
    folder: WorkItemFolder,
    lead: { sourceControl: SourceControlStorageHandle; teardown: CapturedTeardown } | undefined,
  ): Promise<void> {
    await withWorkItemFolderLock(folder.key, () => this.#releaseFolderLocked(folder, lead));
  }

  /**
   * Tear a card's folder down once and remove it, under its lock. The
   * teardown commands run in the `lead` session's sandbox, which works in the
   * folder; with none from this process nothing here set the folder up, so it
   * is only removed, as a detached local session's directory is. Every
   * sandbox of the folder stops before it goes.
   */
  async #releaseFolderLocked(
    folder: WorkItemFolder,
    lead: { sourceControl: SourceControlStorageHandle; teardown: CapturedTeardown } | undefined,
  ): Promise<void> {
    // A folder already gone (released by the card's other deleted session)
    // has nothing left to tear down.
    const present =
      this.#sandbox instanceof LocalFactorySandbox
        ? await access(this.#sandbox.workItemFolderPath(folder.key)).then(
            () => true,
            () => false,
          )
        : true;
    if (present && lead?.teardown.entry?.folder?.key === folder.key) {
      await this.#runTeardownCommands(lead, lead.teardown);
    }
    const stopping = new Set<WorkspaceSandbox>();
    if (lead?.teardown.entry?.folder?.key === folder.key) stopping.add(lead.teardown.entry.sandbox);
    for (const { sessionId, entry } of peekWorkItemFolderSessions(folder.key)) {
      evictSessionSandbox(sessionId);
      stopping.add(entry.sandbox);
    }
    for (const sandbox of stopping) await this.#stopSandbox(undefined, sandbox);
    if (this.#sandbox instanceof LocalFactorySandbox) {
      try {
        await this.#sandbox.removeWorkItemFolder(folder.key);
      } catch (error) {
        this.#warn('Factory card folder removal failed', { folder: folder.key, error: boundedError(error) });
      }
    }
  }

  /** Stop a sandbox, logging a failure; the session (when given) leaves this process's memo first. */
  async #stopSandbox(session: SourceControlSession | undefined, sandbox: WorkspaceSandbox | undefined): Promise<void> {
    if (session && peekSessionSandbox(session.id)?.sandbox === sandbox) evictSessionSandbox(session.id);
    if (!sandbox) return;
    const lifecycle = sandbox as unknown as { _stop?: () => Promise<void>; stop?: () => Promise<void> };
    try {
      await (lifecycle._stop ? lifecycle._stop.call(sandbox) : lifecycle.stop?.call(sandbox));
    } catch (error) {
      this.#warn('Factory session sandbox stop failed', {
        ...(session ? { orgId: session.orgId, sessionId: session.sessionId } : {}),
        sandbox: sandbox.id,
        error: boundedError(error),
      });
    }
  }

  async #teardownSessionSandbox(input: RetireSessionInput, session: SourceControlSession): Promise<void> {
    const entry = peekSessionSandbox(session.id);
    if (!entry) {
      await this.#destroyDetachedSandbox(input, session);
      return;
    }
    await this.#runTeardownCommands(input, this.#captureTeardown(session));
    await this.#releaseSandbox(input, session);
  }

  /**
   * Run the session's teardown commands in its sandbox. A session booted
   * from its factory environment tears every repository down in position
   * order, each in its own directory; a failure is logged and the next
   * repository still runs.
   */
  async #runTeardownCommands(
    input: { sourceControl: SourceControlStorageHandle },
    { session, entry, environment }: CapturedTeardown,
  ): Promise<void> {
    if (!entry) return;
    if (environment.length > 0) {
      for (const repo of environment) {
        try {
          await runTeardownCommand(requireExec(entry.sandbox), repo.dir, repo.command, {
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          });
        } catch (error) {
          this.#warn('Factory teardown command failed', {
            orgId: session.orgId,
            sessionId: session.sessionId,
            projectRepositoryId: session.projectRepositoryId,
            repository: repo.slug,
            error: boundedError(error),
          });
        }
      }
      return;
    }

    let projectRepository: ProjectRepository | null | undefined;
    try {
      projectRepository = session.projectRepositoryId
        ? await input.sourceControl.projectRepositories.get({ orgId: session.orgId, id: session.projectRepositoryId })
        : null;
    } catch (error) {
      this.#warn('Factory repository settings could not be loaded for session retirement', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        projectRepositoryId: session.projectRepositoryId,
        error: boundedError(error),
      });
    }

    // An unresolved workdir means the sandbox never started in this process:
    // nothing was set up, so there is nothing for a teardown command to undo.
    if (projectRepository?.teardownCommand && entry.workdir) {
      try {
        await runTeardownCommand(requireExec(entry.sandbox), entry.workdir, projectRepository.teardownCommand, {
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        this.#warn('Factory teardown command failed', {
          orgId: session.orgId,
          sessionId: session.sessionId,
          projectRepositoryId: session.projectRepositoryId,
          error: boundedError(error),
        });
      }
    }
  }

  /**
   * Destroy a deleted session's VM that this process never attached to. Only
   * for sessions that materialized (a persisted `sandboxId`): nothing is
   * started, no teardown command runs — the provider kills by identity.
   */
  async #destroyDetachedSandbox(input: RetireSessionInput, session: SourceControlSession): Promise<void> {
    if (!this.#sandbox) return;
    // A local sandbox has no VM to pause: it is the checkout on disk, so a finished session frees it too.
    const local = this.#sandbox instanceof LocalFactorySandbox;
    if (!local && (!input.deleteSession || !session.sandboxId)) return;
    try {
      await destroyDetachedSessionSandbox({ sandbox: this.#sandbox, session });
    } catch (error) {
      this.#warn('Factory detached session sandbox destroy failed', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        projectRepositoryId: session.projectRepositoryId,
        error: boundedError(error),
      });
    }
  }

  /** Bump the session's workspace generation; a failing unregister is logged, never fatal. */
  async #invalidate(session: SourceControlSession): Promise<void> {
    try {
      await this.#invalidateSession(session.sessionId);
    } catch (error) {
      this.#warn('Factory session workspace cache invalidation failed', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        projectRepositoryId: session.projectRepositoryId,
        error: boundedError(error),
      });
    }
  }

  async #recreateSessionSandbox(input: RecreateSessionSandboxInput): Promise<'recreated' | 'not-found'> {
    const session = await input.sourceControl.sessions.getBySessionId(input.sessionId);
    if (!session || session.orgId !== input.orgId) return 'not-found';

    // Bump the generation first so an in-flight start hook for the old
    // instance throws instead of republishing its sandbox id.
    await this.#invalidate(session);
    const entry = peekSessionSandbox(session.id);
    evictSessionSandbox(session.id);

    await this.#destroyForRecreate(session, entry?.sandbox);
    await input.sourceControl.sessions.setSandbox({ id: session.id, sandboxId: null, sandboxWorkdir: '' });

    // A resolve that ran between the eviction and clearing the id could have
    // built a fresh instance from the old `sandboxId`; drop it and fence it.
    evictSessionSandbox(session.id);
    await this.#invalidate(session);
    return 'recreated';
  }

  async #resetSessionSandbox(input: RecreateSessionSandboxInput): Promise<'reset' | 'not-found' | 'not-here'> {
    const session = await input.sourceControl.sessions.getBySessionId(input.sessionId);
    if (!session || session.orgId !== input.orgId) return 'not-found';
    const sandbox = peekSessionSandbox(session.id)?.sandbox;
    if (!sandbox) return 'not-here';

    // The provider's own destroy, not the lifecycle wrapper: the wrapper marks
    // the instance destroyed for good. Bounded, so a VM that won't answer
    // can't hold the session lock.
    const destroy = async () => {
      if (!(await this.#settledWithin(this.#destroyDirectly(sandbox)))) {
        throw new Error('Timed out destroying the sandbox. Try again.');
      }
    };
    // Destroyed before waiting on a start in flight, so a start hung on the
    // dead VM can't block recovery; its commands fail fast once the VM is gone.
    await destroy();
    const starting = (sandbox as { _startPromise?: Promise<unknown> })._startPromise;
    if (starting) {
      const settled = await this.#settledWithin(
        starting.then(
          () => {},
          () => {},
        ),
      );
      if (!settled) throw new Error('The old sandbox is still starting. Try again.');
      // That start may have found the old VM gone and provisioned another.
      await destroy();
    }

    sandbox.status = 'stopped';
    // The new VM runs setup from scratch, including commands that failed on the old one.
    clearFailedSetupCommands(session.id);
    // Re-read: a start that settled while this reset waited may have stored a newer workdir.
    const latest = await input.sourceControl.sessions.getBySessionId(input.sessionId);
    await input.sourceControl.sessions.setSandbox({
      id: session.id,
      sandboxId: null,
      sandboxWorkdir: latest?.sandboxWorkdir ?? session.sandboxWorkdir ?? '',
    });
    return 'reset';
  }

  /**
   * Destroy the session's VM. `_destroy()` silently no-ops on a never-started
   * (`pending`) instance, so pending and detached instances call the
   * provider's `destroy()` directly; a started instance goes through the
   * lifecycle wrapper, bounded so a hung start can't hold the session lock.
   */
  async #destroyForRecreate(session: SourceControlSession, memo: WorkspaceSandbox | undefined): Promise<void> {
    const lifecycle = memo as { _destroy?: () => Promise<void> } | undefined;
    if (memo && memo.status !== 'pending' && lifecycle?._destroy) {
      const destroying = lifecycle._destroy.call(memo);
      if (await this.#settledWithin(destroying)) {
        memo.status = 'destroyed';
        return;
      }
      // Load-bearing: once the hung start settles, this destroy reaps any VM it
      // provisioned. Its rejection must never surface as unhandled.
      destroying.catch(error =>
        this.#warn('Factory sandbox destroy failed after recreate stopped waiting', {
          orgId: session.orgId,
          sessionId: session.sessionId,
          error: boundedError(error),
        }),
      );
      if (!this.#sandbox) {
        throw new Error(
          'Timed out destroying the session sandbox, and no sandbox provider is configured to retry by identity.',
        );
      }
      await this.#destroyDetachedForRecreate(this.#sandbox, session);
      memo.status = 'destroyed';
      return;
    }

    if (memo) {
      await this.#destroyDirectly(memo);
      memo.status = 'destroyed';
      return;
    }

    // No instance in this process (restart, or another replica opened it):
    // destroy through a never-started instance carrying the persisted id.
    // Unlike retirement, this runs without a `sandboxId` too: E2B and Docker
    // find the VM by session identity, and Platform's destroy no-ops safely.
    if (this.#sandbox) await this.#destroyDetachedForRecreate(this.#sandbox, session);
  }

  async #destroyDetachedForRecreate(sandbox: FactorySandbox, session: SourceControlSession): Promise<void> {
    try {
      await destroyDetachedSessionSandbox({ sandbox, session });
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    }
  }

  /** True when the destroy finished in time; false on timeout. Gone-VM errors count as finished. */
  async #settledWithin(destroying: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), this.#destroyTimeoutMs);
    });
    try {
      return await Promise.race([destroying.then(() => true as const), timedOut]);
    } catch (error) {
      if (isSandboxGoneError(error)) return true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #destroyDirectly(sandbox: WorkspaceSandbox): Promise<void> {
    try {
      await sandbox.destroy?.();
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    }
  }

  async #releaseSandbox(input: RetireSessionInput, session: SourceControlSession): Promise<void> {
    try {
      await releaseSessionSandbox({
        sessionId: session.id,
        destroy: input.deleteSession || this.#sandbox instanceof LocalFactorySandbox,
      });
    } catch (error) {
      this.#warn('Factory session sandbox release failed', {
        orgId: session.orgId,
        sessionId: session.sessionId,
        projectRepositoryId: session.projectRepositoryId,
        error: boundedError(error),
      });
    }
  }
}
