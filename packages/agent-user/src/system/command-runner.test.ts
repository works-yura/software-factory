import { describe, expect, it } from 'vitest';

import { ExecFileRunner } from './command-runner.ts';

describe('ExecFileRunner', () => {
  it('reports the exit code and stderr, never rejects', async () => {
    const runner = new ExecFileRunner();
    expect(await runner.run('/usr/bin/true', [])).toEqual({ code: 0, stderr: '' });
    expect((await runner.run('/usr/bin/false', [])).code).toBe(1);
    expect((await runner.run('/bin/sh', ['-c', 'echo oops >&2; exit 3'])).stderr).toBe('oops\n');
  });

  it('a command that cannot start or runs past its time gives no exit code', async () => {
    expect((await new ExecFileRunner().run('/nonexistent/command', [])).code).toBeNull();
    expect((await new ExecFileRunner(100).run('/bin/sleep', ['5'])).code).toBeNull();
  });
});
