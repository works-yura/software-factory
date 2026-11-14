/**
 * The Factory's usage: every session's turns recorded (`observeSessionUsage`), and the turn
 * harnesses' usage facets, which read their accounts' allowances (each harness module's). The usage routes
 * (`@factory/api` `UsageRoutes`) read both.
 */
import type { HarnessUsage, HarnessUsageRegistry } from '@factory/harness/usage';
import { createHarnessUsageRegistry } from '@factory/harness/usage';
import type { SourceControlSession, UsageStorage } from '@factory/store';

import type { UsageObservedSession } from './recorder.ts';
import { observeSessionUsage } from './recorder.ts';

export * from './probes.ts';
export * from './recorder.ts';

export interface FactoryUsage {
  readonly storage: UsageStorage;
  readonly registry: HarnessUsageRegistry;
  /** Records the session's turns; call once per session object, as the harness creates it. */
  observe(session: UsageObservedSession, input: { sessionId: string; harnessId: string; modelFor?: () => Promise<string | undefined> }): () => void;
}

export function createFactoryUsage(options: {
  storage: UsageStorage;
  sessions: { getBySessionId(sessionId: string): Promise<SourceControlSession | null | undefined> };
  /** The running harnesses' usage facets (their modules', ADR-0044), in the registry's order. */
  facets: readonly HarnessUsage[];
}): FactoryUsage {
  const facets = [...options.facets];
  return {
    storage: options.storage,
    registry: createHarnessUsageRegistry(facets),
    observe: (session, input) => observeSessionUsage(session, input, { usage: options.storage, sessions: options.sessions }),
  };
}
