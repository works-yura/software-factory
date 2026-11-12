import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createHarnessExecutable } from '@factory/harness/executable';

import { CLAUDE_CODE_EXECUTABLE, CODEX_EXECUTABLE, harnessExecutableFor, reportHarnessExecutables } from './harness-executables.ts';

function installed(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'server-exe-'));
  writeFileSync(join(dir, name), '#!/bin/sh\necho "9.9.9 (fake)"\n');
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
}

describe('harnessExecutableFor', () => {
  it("resolves the deployment's command, or the default name, in the harness's environment", () => {
    const claude = installed('claude');
    expect(harnessExecutableFor({ command: claude }, CLAUDE_CODE_EXECUTABLE)?.command()).toBe(claude);
    expect(harnessExecutableFor({ env: { PATH: dirname(claude) } }, CLAUDE_CODE_EXECUTABLE)?.command()).toBe(claude);
    const missing = harnessExecutableFor({ command: '/nowhere/codex' }, CODEX_EXECUTABLE)!;
    expect(missing.unavailableReason()).toBe(
      'Codex is not installed on this server: `/nowhere/codex` was not found. Looked in: /nowhere/codex. ' +
        'Install it, or set FACTORY_CODEX_COMMAND to its absolute path, and the harness becomes available without a restart.',
    );
  });

  it('leaves the command as given to a host that spawns on its own, or that resolved it already', () => {
    expect(harnessExecutableFor({ command: 'claude', spawn: () => undefined }, CLAUDE_CODE_EXECUTABLE)).toBeUndefined();
    const own = createHarnessExecutable({ harness: 'Codex', name: 'codex', env: {} });
    expect(harnessExecutableFor({ command: own }, CODEX_EXECUTABLE)).toBeUndefined();
  });
});

describe('reportHarnessExecutables', () => {
  it('logs where each CLI is and its version, and warns where one is missing', async () => {
    const claude = installed('claude');
    const log = { info: vi.fn(), warn: vi.fn() };
    const reports = await reportHarnessExecutables(
      [harnessExecutableFor({ command: claude }, CLAUDE_CODE_EXECUTABLE), undefined, harnessExecutableFor({ command: '/nowhere/codex' }, CODEX_EXECUTABLE)],
      log,
    );
    expect(reports.map(report => report.found)).toEqual([true, false]);
    expect(log.info).toHaveBeenCalledWith(`[factory] Claude Code: ${claude} (configured, 9.9.9 (fake)).`);
    expect(log.warn).toHaveBeenCalledWith(
      '[factory] Codex: `codex` not found (looked in /nowhere/codex). Codex sessions cannot run until it is installed.',
    );
  });
});
