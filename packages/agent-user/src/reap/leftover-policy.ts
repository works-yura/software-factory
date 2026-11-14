import type { ProcessRow } from './process-table.ts';

export interface LeftoverPolicy {
  /** The agent user's name, as `ps` prints it. */
  readonly agentUser: string;
  /** The server: an agent process under it belongs to a turn that is still running. */
  readonly serverPid: number;
  /**
   * How long a detached process may outlive the turns: it is left alone this long while no turn
   * runs (a Mastra turn between two commands has none), 0 at server start.
   */
  readonly idleGraceSeconds: number;
  /** A detached process older than this goes even while turns run (a forgotten dev server). */
  readonly maxAgeSeconds: number;
  /**
   * Executables macOS starts for the user on its own (launchd agents: cfprefsd, trustd, the
   * simulator and device services). Killing them does nothing but restart them.
   */
  readonly systemPrefixes: readonly string[];
}

export const MACOS_SYSTEM_PREFIXES = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/', '/Library/Developer/PrivateFrameworks/'] as const;

/** Whether `row` descends from `ancestor` (by parent pids, stopping at launchd). */
function descendsFrom(row: ProcessRow, ancestor: number, byPid: ReadonlyMap<number, ProcessRow>): boolean {
  const seen = new Set<number>();
  for (let current: ProcessRow | undefined = row; current && current.pid > 1 && !seen.has(current.pid); current = byPid.get(current.ppid)) {
    if (current.pid === ancestor) return true;
    seen.add(current.pid);
  }
  return false;
}

/**
 * The agent processes no turn owns: detached from the server (daemons, `nohup … &`, a turn's
 * children after the server restarted). Pure: decides from one `ps` snapshot.
 */
export function findLeftovers(rows: readonly ProcessRow[], policy: LeftoverPolicy): number[] {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const agent = rows.filter(row => row.user === policy.agentUser);
  const attached = agent.filter(row => descendsFrom(row, policy.serverPid, byPid));
  const turnsRunning = attached.length > 0;
  return agent
    .filter(row => !attached.includes(row))
    .filter(row => !policy.systemPrefixes.some(prefix => row.command.startsWith(prefix)))
    .filter(row => row.ageSeconds >= (turnsRunning ? policy.maxAgeSeconds : policy.idleGraceSeconds))
    .map(row => row.pid);
}
