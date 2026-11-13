import { execFile } from 'node:child_process';

/** Runs a short command to its end; never rejects (the caller decides what a failure means). */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }>;
}

export class ExecFileRunner implements CommandRunner {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  run(command: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise(resolve => {
      execFile(command, [...args], { env: { PATH: '/usr/bin:/bin' }, timeout: this.timeoutMs }, (error, _stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
        resolve({ code, stderr: String(stderr ?? '') });
      });
    });
  }
}
