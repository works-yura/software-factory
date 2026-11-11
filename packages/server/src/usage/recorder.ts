/**
 * Records what every agent turn spent, whatever harness ran it: the harness's `usage_update`
 * steps are summed until the turn ends (`agent_end`, any reason, a parked turn included: its
 * tokens were spent), then written as one usage row with the session's Factory, owner, the card run
 * the turn belonged to and the role it played, the model and the account. Allowance windows a turn is told
 * (`usage_limits_update`) are kept on the account as they arrive.
 */
import type { AgentEvent, AgentTokenUsage } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import type { UsageLimitsUpdateEvent, UsageTokenTotals } from '@factory/harness/usage';
import { addTokenTotals, emptyTokenTotals, isUsageLimitsUpdateEvent, tokenTotalsOf } from '@factory/harness/usage';
import { listSessionOpenRuns } from '@factory/runtime';
import type { FactoryOpenRun } from '@factory/runtime';
import type { RecordUsageTurnInput, SourceControlSession, UsageStorage } from '@factory/store';

/** What the recorder needs of a session; Claude Code's, Codex's and Mastra's all have it. */
export interface UsageObservedSession {
  readonly thread: {
    getId(): string | undefined;
    getSetting(input: { key: string }): Promise<unknown>;
  };
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** The shared transcript (turn harnesses): the model a turn runs and the cost the provider reports. */
  onTranscript?(listener: (entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void): () => void;
  /** The account the session's turns run on, when it has accounts. */
  readonly accountId?: string | undefined;
}

export interface SessionUsageRecorderDeps {
  usage: Pick<UsageStorage, 'recordTurn' | 'mergeAccountLimits'>;
  /** The session's row: its organization, Factory and owner. A session without one is not recorded. */
  sessions: { getBySessionId(sessionId: string): Promise<SourceControlSession | null | undefined> };
  now?: () => Date;
  /** Told when a row could not be written (the default logs it). */
  onError?: (error: unknown) => void;
}

interface TurnInProgress {
  totals: UsageTokenTotals;
  steps: number;
  lastPrompt: number | null;
  costUsd: number | null;
  runId: string | null;
  /** The card runs open when the turn's first step came: the ledger may be cleared by the time it ends. */
  openRuns: Promise<FactoryOpenRun[]>;
}

/**
 * Watches one session's turns and records each as a usage row. `harnessId` names the harness
 * (`claude-code`, `codex`, `mastra`); `modelFor` reads the model when the session's transcript does
 * not name it (a Mastra session's thread setting). Returns the unsubscribe.
 */
export function observeSessionUsage(
  session: UsageObservedSession,
  input: { sessionId: string; harnessId: string; modelFor?: () => Promise<string | undefined> },
  deps: SessionUsageRecorderDeps,
): () => void {
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (error => console.warn('[Factory usage] Unable to record a turn’s usage.', error));
  let model: string | undefined;
  let pendingCost: number | null = null;
  let turn: TurnInProgress | undefined;
  let row: Promise<SourceControlSession | null | undefined> | undefined;
  const sessionRow = () => (row ??= deps.sessions.getBySessionId(input.sessionId).catch(() => null));

  const startTurn = (): TurnInProgress => ({
    totals: emptyTokenTotals(),
    steps: 0,
    lastPrompt: null,
    costUsd: pendingCost,
    runId: null,
    openRuns: listSessionOpenRuns(session as never).catch(() => []),
  });

  const step = (usage: AgentTokenUsage) => {
    turn ??= startTurn();
    pendingCost = null;
    turn.totals = addTokenTotals(turn.totals, tokenTotalsOf(usage));
    turn.steps += 1;
    if (typeof usage.promptTokens === 'number' && usage.promptTokens > 0) turn.lastPrompt = usage.promptTokens;
  };

  const flush = async (ended: TurnInProgress, at: Date) => {
    const source = await sessionRow();
    if (!source) return;
    const openRuns = await ended.openRuns;
    const cardRun = openRuns.find(run => run.workItemId);
    const turnModel = model ?? (await input.modelFor?.().catch(() => undefined));
    const record: RecordUsageTurnInput = {
      orgId: source.orgId,
      sessionId: input.sessionId,
      threadId: session.thread.getId() ?? null,
      runId: ended.runId,
      factoryProjectId: cardRun?.factoryProjectId ?? source.factoryProjectId,
      workItemId: cardRun?.workItemId ?? null,
      kickoffId: cardRun?.kickoffId ?? null,
      role: cardRun?.role ?? null,
      userId: source.userId,
      harnessId: input.harnessId,
      model: turnModel ?? null,
      accountId: session.accountId ?? null,
      occurredAt: at.toISOString(),
      totals: ended.totals,
      stepCount: ended.steps,
      contextTokens: ended.lastPrompt,
      reportedCostUsd: ended.costUsd,
    };
    await deps.usage.recordTurn(record);
  };

  const offTranscript = session.onTranscript?.((entry, meta) => {
    if (entry.kind === 'init' && entry.model) model = entry.model;
    if (entry.kind === 'result' && typeof entry.costUsd === 'number') {
      // A turn moved to another account reports a result per attempt: they add up.
      if (turn) turn.costUsd = (turn.costUsd ?? 0) + entry.costUsd;
      else pendingCost = (pendingCost ?? 0) + entry.costUsd;
    }
    if (turn && !turn.runId) turn.runId = meta.runId;
  });

  const offEvents = session.subscribe(incoming => {
    // Harnesses emit `usage_limits_update` beside the runtime's own events.
    const event = incoming as AgentEvent | UsageLimitsUpdateEvent;
    if (event.type === 'usage_update') {
      step(event.usage);
      return;
    }
    if (isUsageLimitsUpdateEvent(event)) {
      const accountId = event.accountId ?? session.accountId;
      if (!accountId) return;
      void sessionRow()
        .then(source =>
          source ? deps.usage.mergeAccountLimits(source.orgId, accountId, { windows: event.windows, checkedAt: event.checkedAt }) : undefined,
        )
        .catch(onError);
      return;
    }
    if (event.type !== 'agent_end') return;
    const ended = turn;
    turn = undefined;
    if (!ended) {
      pendingCost = null;
      return;
    }
    void flush(ended, now()).catch(onError);
  });

  return () => {
    offEvents();
    offTranscript?.();
  };
}
