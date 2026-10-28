import { externallyAuthoredWorkItem } from '@factory/core';
import type { ClaudeCodeHarness, ClaudeCodeSession, ClaudePermissionMode } from '@factory/harness-claude-code';
import {
  commitRunStart,
  resolveSourceSession,
  resolveStartRepository,
  UntrustedSharedSessionError,
} from '@factory/harness-mastra';
import type { FactoryStartPreparedResult, FactoryStartRequest } from '@factory/harness-mastra';
import type { FactoryTransitionService } from '@factory/runtime';
import { FactoryDispatchError } from '@factory/store';
import type { FactoryProjectsStorage, SourceControlStorageHandle, WorkItemsStorage } from '@factory/store';

/** Thread settings a Claude Code session carries, read by the chat and by later starts. */
export const CLAUDE_THREAD_SETTINGS = {
  sessionId: 'factorySessionId',
  workItemId: 'factoryWorkItemId',
  title: 'factoryThreadTitle',
  targetRepository: 'factoryTargetRepository',
  /** The Factory chat (supervisor): the person whose message or answer started its latest turn. */
  actorUserId: 'factoryActorUserId',
} as const;

export interface ClaudeStartCoordinatorOptions {
  harness: Pick<ClaudeCodeHarness, 'getSession' | 'createSession'>;
  storage: WorkItemsStorage;
  transitionService?: Pick<FactoryTransitionService, 'transition'>;
  sourceControl:
    | SourceControlStorageHandle
    | ((
        request: FactoryStartRequest,
      ) => SourceControlStorageHandle | undefined | Promise<SourceControlStorageHandle | undefined>);
  projects: Pick<FactoryProjectsStorage, 'get'>;
  /** The mode a session leaves planning in once its plan is approved; `acceptEdits` by default. */
  approvedPermissionMode?: ClaudePermissionMode;
}

/**
 * Starts a card's role in a Claude Code session: the equivalent of
 * `FactoryStartCoordinator.prepare` for a factory whose harness is
 * `claude-code`. The source-control session, repository check, binding,
 * arrival move and kickoff record are the Mastra start's own (shared
 * helpers); what differs is the session:
 *
 * - it is a Claude Code session in the harness's store, addressed by the
 *   source-control session id, its thread id the same id (the chat opens that
 *   thread);
 * - its memory resource follows the Mastra rule: trusted runs share the
 *   factory's, a run on externally authored content keeps its own, and a
 *   session already sharing refuses untrusted work;
 * - the plan role plans behind the harness's `submit_plan` gate unless plans
 *   are auto-approved; a later role in the same session answers a plan still
 *   parked there (the card left Planning, which is the approval) and leaves
 *   planning mode.
 *
 * A pull-request checkout is refused: its `.claude/` settings and CLAUDE.md
 * are attacker-writable and the CLI reads them from the cwd. Review of change
 * requests waits for the sandbox phase.
 */
export class ClaudeStartCoordinator {
  readonly #options: ClaudeStartCoordinatorOptions;

  constructor(options: ClaudeStartCoordinatorOptions) {
    this.#options = options;
  }

  async prepare(request: FactoryStartRequest): Promise<FactoryStartPreparedResult> {
    const { storage, projects } = this.#options;
    const sourceControl =
      typeof this.#options.sourceControl === 'function'
        ? await this.#options.sourceControl(request)
        : this.#options.sourceControl;
    if (!sourceControl) throw new Error('Factory source control storage is unavailable');
    const sourceSession = await resolveSourceSession(sourceControl, request);
    const storedItem = request.workItem.id
      ? await storage.get({ orgId: request.orgId, id: request.workItem.id })
      : null;
    const repository = await resolveStartRepository({ sourceControl, request, sourceSession, storedItem });

    if (request.workItem.input.externalSource?.type === 'pull-request') {
      throw new FactoryDispatchError(
        'unsupported_provider_item',
        'Claude Code sessions do not run on pull-request checkouts yet: the checkout’s Claude settings are untrusted.',
      );
    }
    const untrusted = externallyAuthoredWorkItem(
      storedItem ?? {
        externalSource: request.workItem.input.externalSource ?? null,
        metadata: request.workItem.input.metadata ?? null,
      },
    );
    const sessionId = sourceSession.sessionId;
    const existing = await this.#options.harness.getSession(sessionId);
    const resourceId = memoryResource({
      existing: existing?.resourceId,
      sessionId,
      factoryProjectId: request.factoryProjectId,
      untrusted,
    });
    // The Factory's thread convention: the session's thread is the session id, the one the chat opens.
    const session =
      existing ?? (await this.#options.harness.createSession({ sessionId, threadId: sessionId, resourceId }));
    const threadId = session.thread.requireId();
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId, value: sessionId });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.title, value: request.threadTitle });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.targetRepository, value: repository.slug });

    const project = await projects.get({ orgId: request.orgId, id: request.factoryProjectId });
    await this.#applyRoleMode(session, request.workItem.role, project?.autoApprovePlans === true);

    return commitRunStart({
      storage,
      transitionService: this.#options.transitionService,
      request,
      sourceSession,
      threadId,
      resourceId,
      onPrepared: item => session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.workItemId, value: item.id }),
    });
  }

  async #applyRoleMode(session: ClaudeCodeSession, role: string, plansAutoApproved: boolean): Promise<void> {
    if (role === 'plan') {
      // Auto-approved plans need no gate: the plan skill moves the card on itself.
      if (!plansAutoApproved && session.mode !== 'planning') await session.setMode('planning');
      return;
    }
    if (session.pendingPlan) {
      // A role after the plan runs because the card left Planning: a person moved it on.
      await session.queuePlanAnswer({ resumeData: { action: 'approved' }, toolCallId: session.pendingPlan.toolCallId });
      return;
    }
    if (session.mode === 'planning') await session.setMode(this.#options.approvedPermissionMode ?? 'acceptEdits');
  }
}

function memoryResource({
  existing,
  sessionId,
  factoryProjectId,
  untrusted,
}: {
  existing: string | undefined;
  sessionId: string;
  factoryProjectId: string;
  untrusted: boolean;
}): string {
  // Mirrors the Mastra start's `runMemoryResource`: an isolated session stays isolated.
  if (existing === sessionId) return sessionId;
  if (!untrusted) return existing ?? factoryProjectId;
  if (existing) throw new UntrustedSharedSessionError(sessionId);
  return sessionId;
}
