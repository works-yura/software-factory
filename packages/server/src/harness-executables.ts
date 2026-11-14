// The CLIs this server's turn-based harnesses spawn (Claude Code's `claude`, Codex's `codex`),
// resolved once for the server with `@factory/harness/executable` (ADR-0038): the deployment's
// command (FACTORY_CLAUDE_CODE_COMMAND, FACTORY_CODEX_COMMAND), else PATH, else where the CLIs
// install. The harnesses spawn the resolved path, their model facets are unavailable while it is
// missing, the boot log names it, and `/web/config/versions` reports it.
import {
  createHarnessExecutable,
  formatHarnessExecutableReport,
  type HarnessCommand,
  type HarnessExecutable,
  type HarnessExecutableReport,
  type HarnessExecutableSpec,
} from '@factory/harness/executable';

type ExecutableIdentity = Pick<HarnessExecutableSpec, 'harness' | 'name' | 'setting'>;

export const CLAUDE_CODE_EXECUTABLE: ExecutableIdentity = { harness: 'Claude Code', name: 'claude', setting: 'FACTORY_CLAUDE_CODE_COMMAND' };
export const CODEX_EXECUTABLE: ExecutableIdentity = { harness: 'Codex', name: 'codex', setting: 'FACTORY_CODEX_COMMAND' };
export const OPENCODE_EXECUTABLE: ExecutableIdentity = { harness: 'OpenCode', name: 'opencode', setting: 'FACTORY_OPENCODE_COMMAND' };

/**
 * The executable a harness's config spawns. Undefined when the host launches the CLI itself: an
 * injected `spawn` (tests, a remote runner) takes the command as given, and a command that is
 * already a resolver is used as is.
 */
export function harnessExecutableFor(
  config: { readonly command?: HarnessCommand; readonly spawn?: unknown; readonly env?: Record<string, string | undefined> },
  identity: ExecutableIdentity,
): HarnessExecutable | undefined {
  if (config.spawn || (config.command !== undefined && typeof config.command !== 'string')) return undefined;
  return createHarnessExecutable({
    ...identity,
    ...(config.command?.trim() ? { configured: config.command } : {}),
    env: config.env ?? process.env,
  });
}

/**
 * Resolves each executable now and logs where it is and its version, or that it is missing and
 * where it looked: the first thing to read when a harness does not run.
 */
export async function reportHarnessExecutables(
  executables: ReadonlyArray<HarnessExecutable | undefined>,
  log: Pick<Console, 'info' | 'warn'> = console,
): Promise<HarnessExecutableReport[]> {
  const reports = await Promise.all(executables.filter((executable): executable is HarnessExecutable => executable !== undefined).map(executable => executable.report()));
  for (const report of reports) {
    if (report.found) log.info(`[factory] ${formatHarnessExecutableReport(report)}`);
    else log.warn(`[factory] ${formatHarnessExecutableReport(report)} ${report.harness} sessions cannot run until it is installed.`);
  }
  return reports;
}
