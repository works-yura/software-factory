/**
 * Each Factory's agent isolation (Settings › Environment › Sandbox › Agent isolation), answered
 * synchronously for every process an agent starts. The launch cannot wait on the database, so
 * the settings are kept here: all Factories are read at start, and each again when it is asked
 * about after `ttlMs`. A Factory not read yet, a folder outside any card, or a failed read gets
 * the default, Seatbelt: the stricter answer, never the looser one.
 */

import { agentIsolationOf, DEFAULT_AGENT_ISOLATION, type AgentIsolation } from './template/local-sandbox-settings.ts';
import { WORK_ITEM_FOLDERS_DIR } from './work-item-folder.ts';

export interface AgentIsolationSource {
  /** Every Factory's id and stored sandbox settings. */
  all(): Promise<Array<{ id: string; sandboxSettings: Record<string, unknown> | null }>>;
  /** One Factory's stored sandbox settings, `null` when it has none or is gone. */
  one(factoryProjectId: string): Promise<Record<string, unknown> | null>;
}

export const AGENT_ISOLATION_TTL_MS = 30_000;

export class AgentIsolationSettings {
  readonly #known = new Map<string, { isolation: AgentIsolation; readAt: number }>();
  readonly #reading = new Set<string>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  #source: AgentIsolationSource | undefined;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? AGENT_ISOLATION_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Where settings come from; reads every Factory once. Resolves when that read is done. */
  async attach(source: AgentIsolationSource): Promise<void> {
    this.#source = source;
    try {
      for (const { id, sandboxSettings } of await source.all()) this.#remember(id, sandboxSettings);
    } catch (error) {
      console.warn('[factory] Could not read the Factories’ agent isolation; Seatbelt applies until they are read.', error);
    }
  }

  /** The isolation for a folder key (`work-items/<factory>/<card>`) or a session folder (the default). */
  forFolderKey(key: string | undefined): AgentIsolation {
    const factoryProjectId = factoryOfFolderKey(key);
    if (!factoryProjectId) return DEFAULT_AGENT_ISOLATION;
    const known = this.#known.get(factoryProjectId);
    if (!known || this.#now() - known.readAt >= this.#ttlMs) this.#read(factoryProjectId);
    return known?.isolation ?? DEFAULT_AGENT_ISOLATION;
  }

  #remember(id: string, settings: Record<string, unknown> | null): void {
    this.#known.set(id, { isolation: agentIsolationOf(settings), readAt: this.#now() });
  }

  #read(id: string): void {
    const source = this.#source;
    if (!source || this.#reading.has(id)) return;
    this.#reading.add(id);
    void source
      .one(id)
      .then(settings => this.#remember(id, settings))
      .catch(() => {})
      .finally(() => this.#reading.delete(id));
  }
}

/** The Factory a folder key belongs to: `work-items/<factory>/<card>` names it; a session folder does not. */
export function factoryOfFolderKey(key: string | undefined): string | undefined {
  const segments = key?.split('/') ?? [];
  return segments[0] === WORK_ITEM_FOLDERS_DIR && segments[1] ? segments[1] : undefined;
}
