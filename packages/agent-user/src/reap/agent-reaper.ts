import type { AgentUserSignaller } from '../signal/agent-user-signaller.ts';
import { findLeftovers, type LeftoverPolicy } from './leftover-policy.ts';
import type { ProcessTable } from './process-table.ts';

export interface ReaperLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Stops the agent processes no turn owns. The server cannot see another user's working folders, so
 * it goes by ancestry: an agent process not under the server is left over. Kills as the agent user
 * (sudo), so it can never reach anyone else's process.
 */
export class AgentReaper {
  readonly #table: ProcessTable;
  readonly #signaller: Pick<AgentUserSignaller, 'signalProcesses'>;
  readonly #policy: LeftoverPolicy;
  readonly #log: ReaperLog;

  constructor(table: ProcessTable, signaller: Pick<AgentUserSignaller, 'signalProcesses'>, policy: LeftoverPolicy, log: ReaperLog = console) {
    this.#table = table;
    this.#signaller = signaller;
    this.#policy = policy;
    this.#log = log;
  }

  /** One pass; returns the pids it killed. Never throws. */
  async sweep(overrides: Partial<LeftoverPolicy> = {}): Promise<number[]> {
    try {
      const rows = await this.#table.list();
      const pids = findLeftovers(rows, { ...this.#policy, ...overrides });
      if (pids.length === 0) return [];
      const names = pids.map(pid => `${pid} ${(rows.find(row => row.pid === pid)?.command ?? '').slice(0, 80)}`);
      this.#log.info(`[agent-reaper] Stopping ${pids.length} left-over agent process(es):\n  ${names.join('\n  ')}`);
      await this.#signaller.signalProcesses(pids, 'SIGKILL');
      return pids;
    } catch (error) {
      this.#log.warn(`[agent-reaper] Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** A pass now with no grace (nothing from before this server can belong to a turn), then every `intervalMs`. */
  start(intervalMs = 60_000): () => void {
    void this.sweep({ idleGraceSeconds: 0 });
    const timer = setInterval(() => void this.sweep(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
