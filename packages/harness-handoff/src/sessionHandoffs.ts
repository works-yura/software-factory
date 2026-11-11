// A Factory session's handoffs, kept on its memory thread (the one place all three harnesses share):
// `prepare` builds a handoff of the thread's real history when the session moves to another
// harness or loses its native conversation, and writes a timeline marker; `forTurn` gives the next
// turn on the target the pending context once, and marks it delivered when the provider took the
// prompt (or leaves it pending when it never did, so the next turn sends it again).
import { randomUUID } from 'node:crypto';

import type { MastraDBMessage } from '@mastra/core/agent-controller';
import { createSignal } from '@mastra/core/signals';

import type { OrchestrationV2ContextHandoff, OrchestrationV2ProviderThread } from './contracts.ts';
import { ContextHandoffBudgetError } from './errors.ts';
import { deliverContextHandoffs, withInlineContext } from './ContextHandoffDelivery.ts';
import { makeContextHandoffService, visibleConversationItems, visibleDeltaRunOrdinals } from './ContextHandoffService.ts';
import { handoffBudget, handoffTokenCapFromEnv } from './handoffBudget.ts';
import {
  CONTEXT_HANDOFF_METADATA_KEY,
  CONTEXT_HANDOFF_SIGNAL_TAG,
  createMemoryHistorySource,
  type HandoffMemory,
} from './memoryHistory.ts';

/** Thread metadata key the session's handoff state lives under. */
export const SESSION_HANDOFF_METADATA_KEY = 'factoryContextHandoff';

/** Why a handoff was made: the session moved to another harness, or its native conversation was lost. */
export type SessionHandoffReason = 'switch' | 'resume_failed';

/** The marker's state, as the chat reads it from `content.metadata.contextHandoff`. */
export interface ContextHandoffMarker {
  readonly handoffId: string;
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  /** Display names of the harnesses ("Claude Code"). */
  readonly from: string;
  readonly to: string;
  readonly reason: SessionHandoffReason;
  /** `pending` until the target's provider took the prompt that carried the context. */
  readonly status: 'pending' | 'delivered' | 'failed';
  readonly error?: string;
}

interface MarkerRecord {
  readonly messageId: string;
  readonly createdAt: string;
  readonly marker: ContextHandoffMarker;
}

/** What the thread keeps under {@link SESSION_HANDOFF_METADATA_KEY}. */
export interface SessionHandoffState {
  /**
   * The native conversation the session's turns now go to, as deliveries are tracked: a new one
   * per handoff, so a target that never saw the history gets it, and a resumed one does not again.
   */
  readonly nativeKey: string | null;
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly markers: Readonly<Record<string, MarkerRecord>>;
}

/** The context a turn carries, and how it reports whether the provider took it. */
export interface TurnHandoff {
  /** Inline history for the prompt, ahead of the person's request. */
  readonly context: string;
  readonly handoffIds: ReadonlyArray<string>;
  /** Once the provider accepted the prompt that carried `context`. Idempotent. */
  readonly delivered: () => Promise<void>;
  /** When the prompt never reached the provider: the handoff stays pending for the next turn. */
  readonly unsent: () => Promise<void>;
}

export interface SessionHandoffsOptions {
  readonly memory: () => Promise<HandoffMemory>;
  /** The harness's display name for a marker ("Claude Code"); the instance id when absent. */
  readonly label?: (instanceId: string) => string;
  /** Defaults to FACTORY_CONTEXT_HANDOFF_TOKEN_CAP, else 16,000. */
  readonly tokenCap?: number;
  readonly now?: () => Date;
}

export interface PrepareSessionHandoffInput {
  readonly threadId: string;
  readonly resourceId: string;
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  readonly reason: SessionHandoffReason;
  /** Leaves out what was stored at or after this time. */
  readonly before?: Date;
  /**
   * The request the turn being sent now carries: its own input, already recorded at the end of the
   * thread, is that request, not history, and is left out.
   */
  readonly currentRequest?: string;
}

export interface TurnHandoffInput {
  readonly threadId: string;
  /** The person's request this turn sends; never shortened, and its size is taken off the budget. */
  readonly userText: string;
  /** The target model's context window, when known. */
  readonly modelContextWindow?: number;
}

export interface SessionHandoffs {
  /** Builds a handoff of the thread's history so far for `toInstanceId` and marks the timeline. */
  prepare(input: PrepareSessionHandoffInput): Promise<OrchestrationV2ContextHandoff>;
  /** The pending context for the thread's next turn; undefined when nothing is pending. */
  forTurn(input: TurnHandoffInput): Promise<TurnHandoff | undefined>;
  /** Marks a handoff failed (the move did not go through), on its record and its marker. */
  fail(input: { readonly threadId: string; readonly handoffId: string; readonly error: string }): Promise<void>;
  /** The thread's handoff state, as stored. */
  state(threadId: string): Promise<SessionHandoffState | undefined>;
}

/** Superseded or failed records kept for the timeline; older ones are dropped. */
const KEEP_SETTLED = 4;

function readState(metadata: Record<string, unknown> | undefined): SessionHandoffState {
  const raw = metadata?.[SESSION_HANDOFF_METADATA_KEY] as Partial<SessionHandoffState> | undefined;
  return {
    nativeKey: typeof raw?.nativeKey === 'string' ? raw.nativeKey : null,
    handoffs: Array.isArray(raw?.handoffs) ? raw.handoffs : [],
    markers: raw?.markers && typeof raw.markers === 'object' ? raw.markers : {},
  };
}

/** Settled records lose their transcript and the oldest go, so the thread row stays small. */
function pruned(state: SessionHandoffState): SessionHandoffState {
  const settled = state.handoffs.filter(handoff => handoff.status !== 'ready');
  const dropped = new Set(settled.slice(0, Math.max(0, settled.length - KEEP_SETTLED)).map(handoff => handoff.id));
  return {
    nativeKey: state.nativeKey,
    handoffs: state.handoffs
      .filter(handoff => !dropped.has(handoff.id))
      .map(handoff => {
        if (handoff.status === 'ready') return handoff;
        const { history: _history, ...rest } = handoff;
        return { ...rest, summaryText: '' };
      }),
    markers: Object.fromEntries(Object.entries(state.markers).filter(([id]) => !dropped.has(id))),
  };
}

export function createSessionHandoffs(options: SessionHandoffsOptions): SessionHandoffs {
  const now = options.now ?? (() => new Date());
  const label = options.label ?? ((instanceId: string) => instanceId);
  const tokenCap = options.tokenCap ?? handoffTokenCapFromEnv();
  // One state change at a time per thread in this process: the thread row is read, changed and written.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(threadId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.finally(() => {
      if (queues.get(threadId) === settled) queues.delete(threadId);
    });
    queues.set(threadId, settled);
    return next;
  };

  const loadState = async (threadId: string): Promise<SessionHandoffState | undefined> => {
    const thread = await (await options.memory()).getThreadById({ threadId });
    if (!thread) return undefined;
    return readState(thread.metadata);
  };

  const writeState = async (threadId: string, change: (state: SessionHandoffState) => SessionHandoffState) => {
    let next: SessionHandoffState | undefined;
    await (await options.memory()).updateThreadMetadata({
      id: threadId,
      update: thread => {
        next = pruned(change(readState(thread.metadata)));
        return { [SESSION_HANDOFF_METADATA_KEY]: next };
      },
    });
    return next;
  };

  const markerMessage = (
    threadId: string,
    resourceId: string,
    record: MarkerRecord,
  ): MastraDBMessage => {
    const { marker } = record;
    const message = createSignal({
      id: record.messageId,
      type: 'reactive',
      tagName: CONTEXT_HANDOFF_SIGNAL_TAG,
      createdAt: record.createdAt,
      contents:
        marker.reason === 'resume_failed'
          ? `Context handoff: ${marker.from} → ${marker.to} (new conversation; the previous one could not be resumed).`
          : `Context handoff: ${marker.from} → ${marker.to}.`,
      attributes: { from: marker.fromInstanceId, to: marker.toInstanceId, status: marker.status },
    }).toDBMessage({ threadId, resourceId });
    message.content.metadata = { ...message.content.metadata, [CONTEXT_HANDOFF_METADATA_KEY]: marker };
    return message;
  };

  const setMarkerStatus = async (threadId: string, handoffIds: ReadonlyArray<string>, status: ContextHandoffMarker['status'], error?: string) => {
    const memory = await options.memory();
    const thread = await memory.getThreadById({ threadId });
    if (!thread) return;
    const state = await writeState(threadId, current => ({
      ...current,
      markers: Object.fromEntries(
        Object.entries(current.markers).map(([id, record]) =>
          handoffIds.includes(id) && record.marker.status !== status
            ? [id, { ...record, marker: { ...record.marker, status, ...(error ? { error } : {}) } }]
            : [id, record],
        ),
      ),
    }));
    const changed = handoffIds.flatMap(id => (state?.markers[id] ? [state.markers[id]!] : []));
    if (changed.length) {
      await memory.saveMessages({ messages: changed.map(record => markerMessage(threadId, thread.resourceId, record)) });
    }
  };

  const prepare: SessionHandoffs['prepare'] = input =>
    serialized(input.threadId, async () => {
      const handoffId = `context-handoff:${randomUUID()}`;
      const nativeKey = `${input.toInstanceId}:${handoffId}`;
      const history = createMemoryHistorySource({
        memory: options.memory,
        resolve: async () => ({
          resourceId: input.resourceId,
          providerInstanceId: input.fromInstanceId,
          providerThreadId: `${input.fromInstanceId}:${input.threadId}`,
          ...(input.before ? { before: input.before } : {}),
        }),
      });
      const records = await history.getThreadRecords(input.threadId, ['runs', 'attempts', 'turnItems']);
      const items = [...visibleConversationItems(records, records.turnItems)];
      if (input.currentRequest !== undefined) {
        for (let last = items.at(-1); last?.type === 'user_message' && input.currentRequest.includes(last.text); last = items.at(-1)) {
          items.pop();
        }
      }
      const createdAt = now().toISOString();
      const service = makeContextHandoffService({ idAllocator: { contextHandoff: () => handoffId }, tokenCap });
      const handoff = await service.prepareProviderHandoff({
        threadId: input.threadId,
        targetRunId: `run:after:${createdAt}`,
        transferId: null,
        fromProviderThreadIds: [`${input.fromInstanceId}:${input.threadId}`],
        toProviderThreadId: nativeKey,
        fromProviderInstanceId: input.fromInstanceId,
        toProviderInstanceId: input.toInstanceId,
        coveredRunOrdinals: visibleDeltaRunOrdinals(records, items),
        runs: records.runs,
        strategy: 'full_thread_summary',
        items,
        createdAt,
      });
      const marker: MarkerRecord = {
        messageId: `${CONTEXT_HANDOFF_SIGNAL_TAG}:${handoffId}`,
        createdAt,
        marker: {
          handoffId,
          fromInstanceId: input.fromInstanceId,
          toInstanceId: input.toInstanceId,
          from: label(input.fromInstanceId),
          to: label(input.toInstanceId),
          reason: input.reason,
          status: 'pending',
        },
      };
      await writeState(input.threadId, state => ({
        nativeKey,
        // The new handoff carries the whole thread: what an earlier one still had pending is in it.
        handoffs: [
          ...state.handoffs.map(previous =>
            previous.status === 'ready' ? { ...previous, status: 'superseded' as const, updatedAt: createdAt } : previous,
          ),
          handoff,
        ],
        markers: { ...state.markers, [handoffId]: marker },
      }));
      await (await options.memory()).saveMessages({ messages: [markerMessage(input.threadId, input.resourceId, marker)] });
      return handoff;
    });

  const fail: SessionHandoffs['fail'] = ({ threadId, handoffId, error }) =>
    serialized(threadId, async () => {
      const failedAt = now().toISOString();
      await writeState(threadId, state => ({
        ...state,
        handoffs: state.handoffs.map(handoff =>
          handoff.id === handoffId ? { ...handoff, status: 'failed' as const, updatedAt: failedAt } : handoff,
        ),
      }));
      await setMarkerStatus(threadId, [handoffId], 'failed', error);
    });

  const forTurn: SessionHandoffs['forTurn'] = input =>
    serialized(input.threadId, async () => {
      const state = await loadState(input.threadId);
      const nativeKey = state?.nativeKey;
      const ready = state?.handoffs.filter(handoff => handoff.status === 'ready') ?? [];
      if (!nativeKey || ready.length === 0) return undefined;
      const stamp = now().toISOString();
      const providerThread: OrchestrationV2ProviderThread = {
        id: nativeKey,
        driver: nativeKey.split(':')[0] ?? 'unknown',
        providerInstanceId: nativeKey.split(':')[0] ?? 'unknown',
        providerSessionId: null,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: nativeKey.split(':')[0] ?? 'unknown', nativeId: nativeKey, strength: 'strong' },
        nativeConversationHeadRef: null,
        status: 'idle',
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: ready.map(handoff => handoff.id),
        forkedFrom: null,
        contextUsage: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const persist = async (handoff: OrchestrationV2ContextHandoff) => {
        await writeState(input.threadId, current => ({
          ...current,
          handoffs: current.handoffs.map(existing => (existing.id === handoff.id ? { ...handoff, updatedAt: now().toISOString() } : existing)),
        }));
      };
      const pending = ready.filter(
        handoff => handoff.delivery?.nativeThreadId !== nativeKey || handoff.delivery.status === 'pending',
      );
      if (pending.length === 0) return undefined;
      let result: Awaited<ReturnType<typeof deliverContextHandoffs>>;
      try {
        result = await deliverContextHandoffs({
          handoffs: pending,
          providerThread,
          budget: handoffBudget({
            tokenCap,
            userText: input.userText,
            attachments: [],
            providerThread,
            nativeContextEstimate: 0,
            ...(input.modelContextWindow ? { modelContextWindow: input.modelContextWindow } : {}),
          }),
          alreadyDeliveredItemIds: new Set(),
          persist,
        });
      } catch (error) {
        if (!(error instanceof ContextHandoffBudgetError)) throw error;
        // The request is never shortened to make room: the turn goes on without the history.
        const failedAt = now().toISOString();
        const ids = pending.map(handoff => handoff.id);
        await writeState(input.threadId, current => ({
          ...current,
          handoffs: current.handoffs.map(handoff =>
            ids.includes(handoff.id) ? { ...handoff, status: 'failed' as const, updatedAt: failedAt } : handoff,
          ),
        }));
        await setMarkerStatus(input.threadId, ids, 'failed', error.message);
        return undefined;
      }
      if (!result.context) return undefined;
      const handoffIds = pending.map(handoff => handoff.id);
      let settled = false;
      return {
        context: result.context,
        handoffIds,
        delivered: async () => {
          if (settled) return;
          settled = true;
          await serialized(input.threadId, async () => {
            await result.delivered();
            await setMarkerStatus(input.threadId, handoffIds, 'delivered');
          });
        },
        unsent: async () => {
          if (settled) return;
          settled = true;
          await serialized(input.threadId, () => result.unsent());
        },
      };
    });

  return { prepare, forTurn, fail, state: loadState };
}

/** The prompt a turn sends with a handoff's context ahead of the person's request (unchanged). */
export const promptWithHandoff = (handoff: Pick<TurnHandoff, 'context'> | undefined, prompt: string): string =>
  handoff ? withInlineContext(handoff.context, prompt) : prompt;
