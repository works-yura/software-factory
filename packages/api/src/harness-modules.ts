/**
 * The harnesses as the API sees them (ADR-0044): one entry per harness module the server knows,
 * with what it adds while it runs here — its flags in `/web/config/features`, its connectors in
 * Settings › Підключення, its own routes. The routes go through the list; none names a harness.
 */
import type { ApiRoute } from '@mastra/core/server';

import type { HarnessDescriptor } from '@factory/harness/descriptor';
import type { ConnectorRegistration } from '@factory/integrations';
import type { SourceControlStorageHandle } from '@factory/store';

import { createAgentAccountsConnections } from './agent-connections.ts';
import { SIGN_IN_ACCOUNT_PROVIDERS } from './credential-accounts.ts';
import type { AccountSignInFlows } from './credential-accounts.ts';
import type { FactoryApiRoutesDeps } from './surface.ts';

/** What a running harness's API facets are built with. */
export interface HarnessApiContext {
  readonly deps: FactoryApiRoutesDeps;
  /** Every source-control partition the session routes span (GitHub's and each registered provider's). */
  readonly sourceControls: SourceControlStorageHandle[];
}

export interface HarnessApiModule {
  readonly descriptor: HarnessDescriptor;
  /** The `/web/config/features` flags this harness owns; each reads false while it does not run here. */
  readonly featureFlags?: readonly string[];
  /** Present while the server runs this harness. */
  readonly running?: {
    /** Its flags' values (only those in {@link HarnessApiModule.featureFlags} are served). */
    readonly features?: Readonly<Record<string, boolean>>;
    /** Its connectors in Settings › Підключення (its accounts, ADR-0036). */
    connectors?(context: HarnessApiContext): ConnectorRegistration[];
    /** Routes only this harness has. */
    routes?(context: HarnessApiContext): ApiRoute[];
  };
}

/** The descriptors of the harnesses that run here, in the server's order: what `/web/config/features` lists. */
export function runningHarnessDescriptors(modules: readonly HarnessApiModule[]): HarnessDescriptor[] {
  return modules.filter(module => module.running !== undefined).map(module => module.descriptor);
}

/** Every harness's flags: false for one that does not run here, its own value otherwise. */
export function harnessFeatureFlags(modules: readonly HarnessApiModule[]): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const module of modules) {
    for (const flag of module.featureFlags ?? []) {
      if (flag in flags) throw new Error(`Harness feature flag '${flag}' is claimed by two harnesses.`);
      flags[flag] = module.running?.features?.[flag] === true;
    }
  }
  return flags;
}

/**
 * The accounts connector of a harness whose turns run on members' sign-ins (ADR-0036): its id is
 * the descriptor's `setup.accounts.connector`, its accounts those of a sign-in provider
 * (`SIGN_IN_ACCOUNT_PROVIDERS`). None when the descriptor names no such provider.
 */
export function signInAccountsConnector(
  context: HarnessApiContext,
  input: { harness: HarnessDescriptor; signIn?: AccountSignInFlows },
): ConnectorRegistration[] {
  const { deps } = context;
  const accounts = input.harness.setup.accounts;
  const provider = accounts ? SIGN_IN_ACCOUNT_PROVIDERS[accounts.provider] : undefined;
  if (!accounts || !provider) return [];
  const facet = deps.usage?.harnesses.forHarness(input.harness.id);
  const users = deps.users;
  return [
    {
      id: accounts.connector,
      connections: createAgentAccountsConnections({
        harness: input.harness,
        kind: provider.kind,
        signInName: provider.name,
        credentials: deps.domains.modelCredentials,
        ...(input.signIn ? { signIn: input.signIn } : {}),
        ...(deps.usage ? { usage: { storage: deps.usage.usage, ...(facet ? { facet } : {}) } } : {}),
        projects: deps.domains.projects,
        ...(users
          ? {
              userName: async (userId: string) => {
                const user = await users.getUser(userId);
                return user?.name?.trim() || user?.email?.trim() || undefined;
              },
            }
          : {}),
      }),
    },
  ];
}
