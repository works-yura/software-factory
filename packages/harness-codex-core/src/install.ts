// Whether the `codex` CLI is on this host: an absolute path, or the first executable of that name
// on PATH (with Windows' extensions). The harness is only offered where it is found.
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function findCodexBinary(command = 'codex', env: Record<string, string | undefined> = process.env): string | undefined {
  const executable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(command) || command.includes('/')) return executable(command) ? command : undefined;
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}
