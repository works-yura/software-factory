import { execFile } from 'node:child_process';

/** One process, as `ps` sees it. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  /** Seconds since it started. */
  readonly ageSeconds: number;
  readonly command: string;
}

/** Every process on the machine (any user's: macOS `ps` shows them all). */
export interface ProcessTable {
  list(): Promise<ProcessRow[]>;
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsed(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`Not an elapsed time: ${JSON.stringify(text)}`);
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** Rows of `ps -axo pid=,ppid=,user=,etime=,command=`; lines that do not parse are skipped. */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, user, elapsed, command] = match as unknown as [string, string, string, string, string, string];
    try {
      rows.push({ pid: Number(pid), ppid: Number(ppid), user, ageSeconds: parseElapsed(elapsed), command });
    } catch {
      // A row cut off mid-way.
    }
  }
  return rows;
}

export class PsProcessTable implements ProcessTable {
  list(): Promise<ProcessRow[]> {
    return new Promise((resolve, reject) => {
      execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,user=,etime=,command='], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout) =>
        error ? reject(error) : resolve(parsePs(stdout)),
      );
    });
  }
}
