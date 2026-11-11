/**
 * The Factory's usage: every session's turns recorded (`observeSessionUsage`), and the turn
 * harnesses' usage facets, which read their accounts' allowances (`./probes.ts`). The usage routes
 * (`@factory/api` `UsageRoutes`) read both.
 */
import type { HarnessUsage, HarnessUsageRegistry } from '@factory/harness/usage';
import { createHarnessUsageRegistry } from '@factory/harness/usage';
import type { SignInOAuth, SourceControlSession, UsageStorage } from '@factory/store';

import { createClaudeHarnessUsage, createCodexHarnessUsage } from './probes.ts';
import type { UsageObservedSession } from './recorder.ts';
import { observeSessionUsage } from './recorder.ts';

export * from './probes.ts';
export * from './recorder.ts';

type SignIn = (orgId: string, accountId: string) => Promise<SignInOAuth | undefined>;

export interface FactoryUsage {
  readonly storage: UsageStorage;
  readonly registry: HarnessUsageRegistry;
  /** Records the session's turns; call once per session object, as the harness creates it. */
  observe(session: UsageObservedSession, input: { sessionId: string; harnessId: string; modelFor?: () => Promise<string | undefined> }): () => void;
}

export function createFactoryUsage(options: {
  storage: UsageStorage;
  sessions: { getBySessionId(sessionId: string): Promise<SourceControlSession | null | undefined> };
  /** Each turn harness's sign-in reader (its credentials' `signIn`); a harness without one has no usage facet. */
  claudeSignIn?: SignIn | undefined;
  codexSignIn?: SignIn | undefined;
  fetch?: typeof fetch;
}): FactoryUsage {
  const facets: HarnessUsage[] = [];
  const probe = (signIn: SignIn) => ({ signIn, ...(options.fetch ? { fetch: options.fetch } : {}) });
  if (options.claudeSignIn) facets.push(createClaudeHarnessUsage(probe(options.claudeSignIn)));
  if (options.codexSignIn) facets.push(createCodexHarnessUsage(probe(options.codexSignIn)));
  return {
    storage: options.storage,
    registry: createHarnessUsageRegistry(facets),
    observe: (session, input) => observeSessionUsage(session, input, { usage: options.storage, sessions: options.sessions }),
  };
}
