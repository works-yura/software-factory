// Moving a session between harnesses (Mastra, Claude Code, Codex) with a context handoff.
//
// A session keeps its id, and so its chat URL, its source-control row and its memory thread (the
// thread is the session id, and every harness keeps its conversation there). What moves is which
// harness holds it: a turn-based harness holds the sessions its store has, and Mastra, the
// fallback, every other one. So a move gives the session up on the source (its store record goes,
// its chat channel detaches) and adopts it on the target (a fresh record; no native conversation),
// and the target's first turn gets the thread's real history from the handoff prepared here.
import { makeProviderSwitchService, ProviderSwitchPlanError } from '@factory/harness-handoff';
import type {
  HandoffMemory,
  OrchestrationV2ProviderCapabilities,
  ProviderInstanceMetadata,
  SessionHandoffs,
} from '@factory/harness-handoff';
import type { TurnHandoffHook } from '@factory/harness';
import type { HarnessSwitch, ModelSwitchResult } from '@factory/harness/models';
import type { SourceControlSessionLookup } from '@factory/session';

/** How one harness takes a session on and gives it up. */
export interface HarnessSessionBinding {
  /** Makes this harness hold the session: thread = the session id, under `resourceId`. */
  adopt(input: { sessionId: string; threadId: string; resourceId: string; title?: string | null }): Promise<void>;
  /** Gives the session up, stopping whatever it holds of it. */
  release(sessionId: string): Promise<void>;
}

export interface HarnessSwitchDependencies {
  handoffs: SessionHandoffs;
  memory: () => Promise<Pick<HandoffMemory, 'getThreadById'>>;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /** Whether the session is mid-run on whichever harness holds it. */
  isRunning(sessionId: string): boolean | Promise<boolean>;
  /** The harnesses a session can move between, by model instance id (`mastra`, `claude-code`, `codex`). */
  bindings: Readonly<Record<string, HarnessSessionBinding | undefined>>;
  /** Whether a harness can take sessions now (its CLI is installed …); available when absent. */
  available?(instanceId: string): boolean;
}

const HANDOFF_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
};

const refused = (status: 400 | 404 | 409 | 503, error: string): ModelSwitchResult => ({ ok: false, status, error });

/** The {@link HarnessSwitch} the server registers with its model registry. */
export function createHarnessSwitch(deps: HarnessSwitchDependencies): HarnessSwitch {
  const metadata = async (instanceId: string): Promise<ProviderInstanceMetadata> => {
    if (!deps.bindings[instanceId]) throw new Error(`No harness takes sessions as ${instanceId}.`);
    // Each harness keeps its own native conversations: none resumes another's.
    return { driver: instanceId, continuationKey: instanceId, enabled: deps.available?.(instanceId) ?? true, capabilities: HANDOFF_CAPABILITIES };
  };
  const planner = makeProviderSwitchService({
    getMetadata: metadata,
    get: async instanceId => {
      await metadata(instanceId);
      return {
        driver: instanceId,
        getCapabilities: async () => HANDOFF_CAPABILITIES,
        planSelectionTransition: async () => ({ type: 'apply_on_next_turn' }),
      };
    },
  });

  return {
    accepts: (toInstanceId, fromInstanceId) =>
      deps.bindings[toInstanceId] !== undefined && (fromInstanceId === undefined || deps.bindings[fromInstanceId] !== undefined),

    async switchHarness({ sessionId, from, to, request, ctx }) {
      const source = deps.bindings[from.instanceId];
      const target = deps.bindings[to.instanceId];
      if (!source || !target) return refused(409, `This session cannot move from ${from.displayName} to ${to.displayName} on this server.`);
      if (request.model === null) return refused(400, `Pick a ${to.displayName} model to move this session there.`);
      const row = await deps.sessions.getBySessionId(sessionId);
      if (!row?.factoryProjectId) {
        return refused(409, `This session cannot move to ${to.displayName}: only a Factory session moves between harnesses.`);
      }
      if (await deps.isRunning(sessionId)) {
        return refused(409, `This session is running: stop it, or wait for its turn to end, before moving it to ${to.displayName}.`);
      }
      const checked = await to.check(
        { ...request, model: request.model },
        { viewer: ctx.viewer, factoryProjectId: row.factoryProjectId },
      );
      if (!checked.ok) return refused(400, checked.error);

      const threadId = sessionId;
      const thread = await (await deps.memory()).getThreadById({ threadId });
      if (!thread) return refused(409, 'This session has no conversation yet: start the new chat on the harness you want instead.');
      const current = (await from.getSelection(sessionId, { ...ctx, sessionId })) ?? { instanceId: from.instanceId, model: 'default' };
      try {
        const plan = await planner.plan({
          projection: {
            thread: {
              id: threadId,
              projectId: row.factoryProjectId,
              title: thread.title ?? '',
              createdBy: 'user',
              creationSource: 'factory',
              providerInstanceId: from.instanceId,
              modelSelection: { instanceId: from.instanceId, model: current.model, ...(current.options ? { options: [...current.options] } : {}) },
              runtimeMode: 'default',
              interactionMode: 'default',
              branch: null,
              worktreePath: null,
              activeProviderThreadId: `${from.instanceId}:${threadId}`,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: new Date(thread.createdAt).toISOString(),
              updatedAt: new Date(thread.updatedAt).toISOString(),
              archivedAt: null,
              deletedAt: null,
            },
            providerSessions: [],
            providerThreads: [
              {
                id: `${from.instanceId}:${threadId}`,
                driver: from.instanceId,
                providerInstanceId: from.instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver: from.instanceId, nativeId: threadId, strength: 'weak' },
                nativeConversationHeadRef: null,
                status: 'idle',
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: new Date(thread.createdAt).toISOString(),
                updatedAt: new Date(thread.updatedAt).toISOString(),
              },
            ],
          },
          targetModelSelection: {
            instanceId: checked.selection.instanceId,
            model: checked.selection.model,
            ...(checked.selection.options ? { options: [...checked.selection.options] } : {}),
          },
        });
        if (plan.transition.type !== 'create_with_handoff') {
          return refused(409, `Moving this session to ${to.displayName} is not a handoff (${plan.transition.type}).`);
        }
      } catch (error) {
        if (error instanceof ProviderSwitchPlanError) return refused(409, error.message);
        throw error;
      }

      const handoff = await deps.handoffs.prepare({
        threadId,
        resourceId: thread.resourceId,
        fromInstanceId: from.instanceId,
        toInstanceId: to.instanceId,
        reason: 'switch',
      });
      // The source first: Mastra holds every session no other harness does, so a move to Mastra is the
      // release, and a turn-based target must not share the session with the source for a moment.
      try {
        await source.release(sessionId);
      } catch (error) {
        await deps.handoffs.fail({ threadId, handoffId: handoff.id, error: messageOf(error) });
        return refused(503, `${from.displayName} could not give the session up: ${messageOf(error)}`);
      }
      try {
        await target.adopt({ sessionId, threadId, resourceId: thread.resourceId, title: row.title ?? null });
      } catch (error) {
        await source.adopt({ sessionId, threadId, resourceId: thread.resourceId, title: row.title ?? null }).catch(() => {});
        await deps.handoffs.fail({ threadId, handoffId: handoff.id, error: messageOf(error) });
        return refused(503, `${to.displayName} could not take the session: ${messageOf(error)}`);
      }
      const applied = await to.setSelection(sessionId, checked.selection, { ...ctx, sessionId });
      return {
        ok: true,
        modelSelection: applied.ok ? applied.modelSelection : null,
        appliesFrom: 'next-turn',
        handoff: { id: handoff.id, fromInstanceId: from.instanceId, toInstanceId: to.instanceId, harnessId: to.harnessId },
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The turn hook a turn-based harness of `instanceId` asks before each turn: the handoff a move
 * left pending, and, when the harness could not resume its native conversation, a handoff of the
 * thread's history to the fresh one (same harness), all delivered once.
 */
export function turnHandoffHook<Session extends { thread: { getId(): string | undefined } }>(
  instanceId: string,
  deps: { handoffs: () => SessionHandoffs | undefined; memory: () => Promise<Pick<HandoffMemory, 'getThreadById'>> },
): TurnHandoffHook<Session> {
  return async (session, request) => {
    const handoffs = deps.handoffs();
    const threadId = session.thread.getId();
    if (!handoffs || !threadId) return undefined;
    if (request.reason === 'resume_failed') {
      const thread = await (await deps.memory()).getThreadById({ threadId });
      if (thread) {
        await handoffs.prepare({
          threadId,
          resourceId: thread.resourceId,
          fromInstanceId: instanceId,
          toInstanceId: instanceId,
          reason: 'resume_failed',
          // This turn's own input is the prompt, not history.
          currentRequest: request.prompt,
        });
      }
    }
    return handoffs.forTurn({ threadId, userText: request.prompt });
  };
}
