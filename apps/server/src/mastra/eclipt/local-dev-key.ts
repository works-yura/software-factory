import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Loopback-only credential key, created once in ~/.mastracode and reused across restarts. */
export function localDevCredentialKey(): string {
  if (process.env.NODE_ENV !== 'development' || process.env.HOST !== '127.0.0.1') {
    throw new Error('Local development encryption requires NODE_ENV=development and HOST=127.0.0.1.');
  }
  const directory = join(homedir(), '.mastracode');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'eclipt-factory-local-dev-key');
  try {
    writeFileSync(path, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readFileSync(path, 'utf8').trim();
}
