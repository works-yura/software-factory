/**
 * Local-development pieces of the Factory host: a stable credential key under
 * ~/.mastracode and a libSQL vector store when there is no Postgres.
 */
export { ownMachineCredentialKey } from './local-dev-key';
export { createLocalVector } from './local-vector';
