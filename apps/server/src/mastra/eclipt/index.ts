/**
 * Eclipt additions to the Factory host. Keep fork-specific behavior here so
 * upstream `index.ts` only carries a few marked hook points (`eclipt:`).
 */
export { createLocalDevAuth } from './local-dev-auth';
export { localDevCredentialKey } from './local-dev-key';
export { createLocalVector } from './local-vector';

/** Loopback-only single-user mode: no sign-in, no Mastra account. */
export const localDevAuthEnabled = process.env.FACTORY_LOCAL_DEV_AUTH === '1';
