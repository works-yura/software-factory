import { AgentEnvError } from './env-error.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws unless `name` is a variable name a POSIX shell takes literally. */
export function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name)) throw new AgentEnvError(`Environment variable name ${JSON.stringify(name)} is not allowed.`);
}

/** Throws when `value` cannot travel through an environment (NUL ends a C string). */
export function assertEnvValue(name: string, value: string): void {
  if (value.includes('\0')) throw new AgentEnvError(`Environment variable ${name} holds a NUL byte.`);
}
