// Extra `codex` launch arguments a host passes to every app-server it starts (`-c key=value`,
// `--enable feature`, …), from `FACTORY_CODEX_LAUNCH_ARGS` or the harness config.

export const CODEX_LAUNCH_ARGS_ENV = 'FACTORY_CODEX_LAUNCH_ARGS';

/** Splits a command line as a POSIX shell would: quotes group, backslashes escape. */
export function tokenizeCliArgs(args?: string): ReadonlyArray<string> {
  const input = args;
  if (!input) return [];

  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === undefined) continue;

    if (quote) {
      if (char === quote) {
        quote = undefined;
        quoted = true;
      } else if (char === '\\' && quote === '"') {
        const next = input[index + 1];
        if (next !== undefined && ['"', '\\', '$', '`'].includes(next)) {
          current += next;
          index++;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (/\s/.test(char)) {
      if (current || quoted) {
        tokens.push(current);
        current = '';
        quoted = false;
      }
    } else if (char === '\\') {
      const next = input[index + 1];
      if (next !== undefined && /[\s'"]/.test(next)) {
        current += next;
        index++;
      } else {
        current += char;
      }
    } else {
      current += char;
    }
  }

  if (current || quoted) tokens.push(current);
  return tokens;
}

/** The environment's launch arguments win over the configured ones. */
export const resolveCodexLaunchArgs = (launchArgs?: string, environment: Record<string, string | undefined> = process.env) =>
  environment[CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || '';

/** The arguments after `codex app-server`. */
export const codexAppServerArgs = (launchArgs?: string): string[] => [...tokenizeCliArgs(launchArgs)];

/** Only the config and feature flags of the launch arguments, for `codex exec`. */
export const codexExecLaunchArgs = (launchArgs?: string): string[] => {
  const args = tokenizeCliArgs(launchArgs);
  const execArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === '--strict-config' || arg.startsWith('--config=') || arg.startsWith('-c=')) {
      execArgs.push(arg);
    } else if (arg === '--config' || arg === '-c' || arg === '--enable' || arg === '--disable') {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith('--enable=') || arg.startsWith('--disable=')) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

/**
 * A Codex home's sign-in is a file in that home, never the OS keyring: a Factory's homes are
 * throwaway or per session, and a keyring item would outlive them (and could reach the person's own).
 */
export const CODEX_FILE_CREDENTIALS_ARGS: readonly string[] = ['-c', 'cli_auth_credentials_store="file"'];
