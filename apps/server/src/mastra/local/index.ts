/**
 * Local-development pieces of the Factory host: loopback-only sign-in, a stable
 * credential key under ~/.mastracode, and a libSQL vector store when there is
 * no Postgres.
 */
export { createLocalDevAuth } from './local-dev-auth';
export { localDevCredentialKey, ownMachineCredentialKey } from './local-dev-key';
export { createLocalVector } from './local-vector';

/** Loopback-only single-user mode: no sign-in, no Mastra account. */
export const localDevAuthEnabled = process.env.FACTORY_LOCAL_DEV_AUTH === '1';
