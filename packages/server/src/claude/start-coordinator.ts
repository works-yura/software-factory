import { autoApprovedExitTool, externallyAuthoredWorkItem } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { PlanDecision } from '@factory/harness';
import type { PlanGate } from '@factory/harness/transcript';
import type { ClaudeSessionMode } from '@factory/harness-claude-code';
import {
  commitRunStart,
  resolveSourceSession,
  resolveStartRepository,
  targetRepositoryInstructionFor,
  UntrustedSharedSessionError,
} from '@factory/harness-mastra';
import type { FactoryStartPreparedResult, FactoryStartRequest } from '@factory/harness-mastra';
import { toBoardSource } from '@factory/runtime';
import type { FactoryTransitionService, ProjectBoardSource } from '@factory/runtime';
import type { FactoryProjectsStorage, SourceControlStorageHandle, WorkItemRow, WorkItemsStorage } from '@factory/store';

/** Thread settings a Claude Code session carries, read by the chat and by later starts. */
export const CLAUDE_THREAD_SETTINGS = {
  sessionId: 'factorySessionId',
  workItemId: 'factoryWorkItemId',
  title: 'factoryThreadTitle',
  targetRepository: 'factoryTargetRepository',
  /** What the agent is told about where it works: one target repository, or every workspace repository. */
  targetInstruction: 'factoryTargetInstruction',
  /** The Factory chat (supervisor): the person whose message or answer started its latest turn. */
  actorUserId: 'factoryActorUserId',
  /** The checkout is a pull or merge request someone outside wrote: its turns read no settings file from it. */
  untrustedCheckout: 'factoryUntrustedCheckout',
  /** A signed-in person's message or answer waits for the next turn, which is then theirs (interactive). */
  personTurn: 'factoryPersonTurn',
  /** The session's own model selection (`ModelSelection`); unset, its turns follow the Factory's model and thinking level. */
  modelSelection: 'factoryModelSelection',
  /** The selection the thread's latest turn ran on, so the next turn can mark a switch. */
  lastModelSelection: 'factoryLastModelSelection',
} as const;

/** What a card's start needs of a turn-based harness's session (Claude Code's, Codex's). */
export interface StartableSession<Mode extends string> {
  readonly resourceId: string | undefined;
  readonly mode: Mode | undefined;
  readonly pendingPlan: PlanGate | undefined;
  readonly thread: { requireId(): string; setSetting(input: { key: string; value: unknown }): Promise<void> };
  setMode(mode: Mode): Promise<void>;
  queuePlanAnswer(input: { resumeData: PlanDecision; toolCallId?: string }): Promise<void>;
}

export interface ClaudeStartCoordinatorOptions<Mode extends string = ClaudeSessionMode> {
  harness: {
    getSession(sessionId: string): Promise<StartableSession<Mode> | undefined>;
    createSession(input: { sessionId: string; threadId: string; resourceId?: string }): Promise<StartableSession<Mode>>;
  };
  storage: WorkItemsStorage;
  transitionService?: Pick<FactoryTransitionService, 'transition'>;
  sourceControl:
    | SourceControlStorageHandle
    | ((
        request: FactoryStartRequest,
      ) => SourceControlStorageHandle | undefined | Promise<SourceControlStorageHandle | undefined>);
  projects: Pick<FactoryProjectsStorage, 'get'>;
  /** The mode a session leaves planning in once its plan is approved; `acceptEdits` (Claude Code's) by default. */
  approvedPermissionMode?: Mode;
  /**
   * The boards, for the card phase's own plan auto-approval (`autoApprovedExitTool`), as the dispatcher
   * decides it for a Mastra run. Without them every plan waits for a person.
   */
  boards?: BoardRegistry | ProjectBoardSource;
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
export class ClaudeStartCoordinator<Mode extends string = ClaudeSessionMode> {
  readonly #options: ClaudeStartCoordinatorOptions<Mode>;

  constructor(options: ClaudeStartCoordinatorOptions<Mode>) {
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

    // A pull or merge request is code someone outside wrote: its `.claude/settings.json` hooks must not run here.
    const untrustedCheckout = request.workItem.input.externalSource?.type === 'pull-request';
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
    // Every card run starts on the Factory's default model: a pick made in the session holds for that
    // run only, as Mastra's start re-applies the Factory's main model (`hydrateFactorySession`).
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.modelSelection, value: null });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.targetRepository, value: repository.slug });
    await session.thread.setSetting({
      key: CLAUDE_THREAD_SETTINGS.targetInstruction,
      value: targetRepositoryInstructionFor(repository),
    });
    // Once untrusted, always: a later role on the same session still runs in that checkout.
    if (untrustedCheckout) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.untrustedCheckout, value: true });

    await this.#applyRoleMode(session, request, await this.#plansAreAutoApproved(request, storedItem));

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

  /**
   * The dispatcher's `#plansAreAutoApproved`: the card's phase ends with an auto-approved `submit_plan`.
   * Plans are approved per board (`exitTool.autoApprove`); the retired project switch no longer counts.
   * The phase is the one the start moves the card into.
   */
  async #plansAreAutoApproved(
    request: FactoryStartRequest,
    storedItem: WorkItemRow | null,
  ): Promise<boolean> {
    const boards = this.#options.boards;
    if (storedItem && boards) {
      const item = request.destinationStage ? { ...storedItem, stages: [request.destinationStage] } : storedItem;
      const registry = await toBoardSource(boards).load({ orgId: request.orgId, factoryProjectId: request.factoryProjectId });
      if (autoApprovedExitTool(registry, item) === 'submit_plan') return true;
    }
    return false;
  }

  async #applyRoleMode(
    session: StartableSession<Mode>,
    request: FactoryStartRequest,
    plansAutoApproved: boolean,
  ): Promise<void> {
    // Planning runs in the `work` context on the Work board, so the lane tells it apart from Building;
    // cards planned before that still start their planner in the `plan` role.
    if (request.workItem.role === 'plan' || request.destinationStage === 'planning') {
      // Auto-approved plans need no gate: the plan skill moves the card on itself.
      if (!plansAutoApproved && session.mode !== 'planning') await session.setMode('planning' as Mode);
      return;
    }
    if (session.pendingPlan) {
      // A role after the plan runs because the card left Planning: a person moved it on.
      await session.queuePlanAnswer({ resumeData: { action: 'approved' }, toolCallId: session.pendingPlan.toolCallId });
      return;
    }
    if (session.mode === 'planning') await session.setMode(this.#options.approvedPermissionMode ?? ('acceptEdits' as Mode));
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
