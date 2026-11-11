import type {
  CredentialKind,
  CredentialOption,
  CredentialProvider,
  CredentialSuggestion,
  DiscoveryResult,
  DiscoverySource,
} from '@factory/capabilities';
import type { McpCredentialRef } from '@factory/core';

/**
 * The accounts integrations lend to MCP servers (Settings › Integrations › Google Cloud → Google Cloud),
 * gathered from the ready integrations at boot. Lists never carry secrets; `readSecret` is for
 * the launcher only.
 */
export class McpCredentials {
  readonly #source: () => readonly CredentialProvider[];

  /** `providers` is read on each call: integrations lend theirs once initialized, after this is built. */
  constructor(providers: () => readonly CredentialProvider[]) {
    this.#source = providers;
  }

  get #providers(): Map<CredentialKind, CredentialProvider> {
    return new Map(this.#source().map(provider => [provider.kind, provider]));
  }

  /** Each kind's accounts; a kind no integration provides is absent. */
  async options(orgId: string): Promise<Partial<Record<CredentialKind, CredentialOption[]>>> {
    const entries = await Promise.all(
      [...this.#providers].map(async ([kind, provider]) => [kind, await provider.list(orgId)] as const),
    );
    return Object.fromEntries(entries);
  }

  async readSecret(orgId: string, ref: McpCredentialRef): Promise<string | null> {
    const provider = this.#providers.get(ref.kind);
    if (!provider) throw new Error(`No integration provides ${ref.kind} accounts; connect it first.`);
    return provider.readSecret(orgId, ref.id);
  }

  /**
   * Choices found with one of the organization's accounts (its projects, a project's databases).
   * A kind or provider that cannot look anything up answers with no items, never an error.
   */
  async discover(
    orgId: string,
    ref: McpCredentialRef,
    source: DiscoverySource,
    context: Record<string, string>,
  ): Promise<DiscoveryResult> {
    const provider = this.#providers.get(ref.kind);
    if (!provider?.discover) return { items: [] };
    return provider.discover(orgId, ref.id, source, context);
  }

  /** Values a Factory's own bindings suggest (its Google Cloud project). */
  async suggestions(orgId: string, factoryProjectId: string): Promise<Partial<Record<CredentialSuggestion, string>>> {
    const found = await Promise.all([...this.#providers.values()].map(provider => provider.suggest?.(orgId, factoryProjectId) ?? {}));
    return Object.assign({}, ...found);
  }
}
