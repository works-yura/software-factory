/**
 * Problems with a sandbox's kept work (ADR-0039), read live from the sandbox
 * records: a save that failed before a removal (the folder is kept), saved
 * commits set aside, a public repository whose work stays local. An item lives
 * as long as the record names the problem; a later successful sleep settles a
 * failed save.
 */

import { createHash } from 'node:crypto';

import type { FactoryAttentionIdentity, FactoryAttentionReceiptRecord, WorkItemsStorage } from '@factory/store';
import { factoryAttentionKey } from '@factory/store';
import type {
  AttentionCounts,
  AttentionEntry,
  AttentionLatest,
  AttentionPageArgs,
  AttentionPageResult,
  AttentionProvider,
  AttentionScope,
  AttentionStreamPosition,
} from '@factory/runtime';
import { matchesView, receiptScope } from '@factory/runtime';

export interface SandboxProblemEntry {
  /** The sandbox folder key: `work-items/<factory>/<card>` or a session's row id. */
  key: string;
  sandboxKind: 'card' | 'session';
  problem: 'save-failed' | 'superseded' | 'public-repository' | 'processes-unchecked';
  message: string;
  at: string;
}

/** Where the problems come from: the local sandbox records of a Factory. */
export interface SandboxProblemSource {
  problemsIn(factoryProjectId: string): Promise<SandboxProblemEntry[]>;
}

interface Problem {
  entry: SandboxProblemEntry;
  /** UUID-shaped, as the attention cursor wants. */
  id: string;
  occurredAt: Date;
  identity: FactoryAttentionIdentity;
}

function uuidOf(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function olderThan(problem: Problem, before: AttentionStreamPosition | undefined): boolean {
  if (!before) return true;
  const gap = problem.occurredAt.getTime() - before.occurredAt.getTime();
  return gap < 0 || (gap === 0 && problem.id.localeCompare(before.id) > 0);
}

/** The sandbox as the person knows it: the card's branch, or the session. */
function sandboxTitle(entry: SandboxProblemEntry): string {
  return entry.sandboxKind === 'card' ? entry.key.split('/').slice(2).join('/') : `session ${entry.key}`;
}

export class SandboxProblemAttentionProvider implements AttentionProvider {
  readonly kind = 'sandbox-problem' as const;
  readonly #workItems: WorkItemsStorage;
  readonly #source: SandboxProblemSource;

  constructor({ workItems, source }: { workItems: WorkItemsStorage; source: SandboxProblemSource }) {
    this.#workItems = workItems;
    this.#source = source;
  }

  async #problems(scope: AttentionScope): Promise<Problem[]> {
    const entries = await this.#source.problemsIn(scope.factoryProjectId);
    return entries
      .map(entry => {
        const occurredAt = new Date(entry.at);
        // UUID-shaped from the folder and the problem: the receipt routes take UUID source ids.
        const id = uuidOf(`${entry.key}|${entry.problem}`);
        return { entry, id, occurredAt, identity: { kind: 'sandbox-problem' as const, sourceId: id, occurrence: occurredAt.getTime() } };
      })
      .filter(problem => !Number.isNaN(problem.occurredAt.getTime()))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async #withReceipts(scope: AttentionScope, problems: Problem[]) {
    const receipts = await this.#workItems.listAttentionReceipts({ ...receiptScope(scope), identities: problems.map(problem => problem.identity) });
    const byKey = new Map<string, FactoryAttentionReceiptRecord>(
      receipts.map(receipt => [factoryAttentionKey(scope.factoryProjectId, receipt), receipt]),
    );
    return problems.map(problem => ({ problem, receipt: byKey.get(factoryAttentionKey(scope.factoryProjectId, problem.identity)) }));
  }

  async counts(scope: AttentionScope): Promise<AttentionCounts> {
    let open = 0;
    let unread = 0;
    for (const { receipt } of await this.#withReceipts(scope, await this.#problems(scope))) {
      if (receipt?.state !== 'archived') open += 1;
      if (receipt === undefined) unread += 1;
    }
    return { open, unread };
  }

  async latest(scope: AttentionScope): Promise<AttentionLatest | null> {
    const [newest] = await this.#withReceipts(scope, (await this.#problems(scope)).slice(0, 1));
    if (!newest) return null;
    return {
      key: factoryAttentionKey(scope.factoryProjectId, newest.problem.identity),
      at: newest.problem.occurredAt,
      unread: newest.receipt === undefined,
    };
  }

  async page(scope: AttentionScope, { view, search, before, limit }: AttentionPageArgs): Promise<AttentionPageResult> {
    const problems = (await this.#problems(scope)).filter(problem => olderThan(problem, before));
    const entries: AttentionEntry[] = [];
    for (const { problem, receipt } of await this.#withReceipts(scope, problems)) {
      if (!matchesView(view, receipt)) continue;
      const title = sandboxTitle(problem.entry);
      if (search && !`${title} ${problem.entry.message}`.toLowerCase().includes(search)) continue;
      if (entries.length === limit) return { entries, hasMore: true };
      entries.push({
        occurredAt: problem.occurredAt,
        resumeCursor: { occurredAt: problem.occurredAt, id: problem.id },
        item: {
          key: factoryAttentionKey(scope.factoryProjectId, problem.identity),
          kind: 'sandbox-problem' as const,
          sourceId: problem.identity.sourceId,
          occurrence: problem.identity.occurrence,
          workItemId: null,
          sandboxKey: problem.entry.key,
          problem: problem.entry.problem,
          title,
          detail: problem.entry.message,
          occurredAt: problem.occurredAt.toISOString(),
          read: receipt !== undefined,
          archived: receipt?.state === 'archived',
          target: { kind: 'settings' as const, section: 'environment' },
        },
      });
    }
    return { entries, hasMore: false };
  }

  async markAllRead(scope: AttentionScope, { before, now }: { before?: AttentionStreamPosition; now: Date }): Promise<{ hasMore: boolean }> {
    const problems = (await this.#problems(scope)).filter(problem => olderThan(problem, before));
    if (problems.length > 0) {
      await this.#workItems.markAttentionReceiptsRead({ ...receiptScope(scope), identities: problems.map(problem => problem.identity), now });
    }
    return { hasMore: false };
  }
}
