// The usage facet of the harness contract, beside the models facet: what a turn harness tells the
// Factory about its accounts' allowances. Token counts need no facet: every harness reports them as
// `usage_update` events, which the Factory records per turn. The server and the UI only go through
// this; they never know which harness answers.
import type { AccountUsageLimits } from './contracts.ts';

/** The account a probe reads, as the Factory files it. */
export interface HarnessUsageAccount {
  readonly orgId: string;
  readonly accountId: string;
}

export interface HarnessUsage {
  /** The harness (`HarnessDescriptor.id`): `claude-code`, `codex`. */
  readonly harnessId: string;
  readonly displayName: string;
  /** The credential-account provider its sign-ins are filed under (`anthropic`, `openai-codex`). */
  readonly accountProvider: string;
  /**
   * Reads the account's allowance windows from the provider now. Absent: the harness only learns
   * them while a turn runs (`usage_limits_update`).
   */
  readAccountLimits?(account: HarnessUsageAccount): Promise<AccountUsageLimits>;
}

/** The server's harnesses, as their usage facets. */
export interface HarnessUsageRegistry {
  register(usage: HarnessUsage): void;
  all(): HarnessUsage[];
  forProvider(accountProvider: string): HarnessUsage | undefined;
  forHarness(harnessId: string): HarnessUsage | undefined;
}

export function createHarnessUsageRegistry(initial: ReadonlyArray<HarnessUsage> = []): HarnessUsageRegistry {
  const facets: HarnessUsage[] = [];
  const registry: HarnessUsageRegistry = {
    register(usage) {
      if (facets.some(existing => existing.harnessId === usage.harnessId)) {
        throw new Error(`A harness already registered usage for ${usage.harnessId}.`);
      }
      facets.push(usage);
    },
    all: () => [...facets],
    forProvider: provider => facets.find(usage => usage.accountProvider === provider),
    forHarness: harnessId => facets.find(usage => usage.harnessId === harnessId),
  };
  for (const usage of initial) registry.register(usage);
  return registry;
}
