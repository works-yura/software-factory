// OpenCode's model facet (`HarnessModels`): the catalog an `opencode serve` lists (its own provider,
// `opencode`, the models it serves without a key: the free ones), a session's own pick kept as a
// thread setting, and the `prompt_async` fields it compiles to. The host supplies where sessions
// live and what a session defaults to (its Factory's `harnessModelDefaults.opencode`).
import { ModelSelection, ProviderOptionSelections, type ProviderOptionDescriptor, type ProviderOptionSelection, type ServerProviderModel } from '@factory/harness/models/contracts';
import type { HarnessModelAvailability, HarnessModelContext, HarnessModels, ModelSwitchResult } from '@factory/harness/models/facet';
import { createModelCapabilities, getModelSelectionStringOptionValue, modelSelectionsEqual } from '@factory/harness/models/model';
import { resolveModelDefault } from '@factory/harness/models/defaults';
import { checkModelSelection, EFFORT_OPTION_ID, modelSwitchBetween } from '@factory/harness/models/selection';

import { OpenCodeHttpError, type OpenCodeProviderList, type OpenCodeProviderModel } from './client.ts';
import type { OpenCodeTurnModelSelection } from './session.ts';

/** `ModelSelection.instanceId` of every OpenCode selection, and `harnessModelDefaults.opencode`. */
export const OPENCODE_INSTANCE_ID = 'opencode';
/** The harness id OpenCode sessions report (`HarnessDescriptor.id`). */
export const OPENCODE_HARNESS_ID = 'opencode';
/** OpenCode's own provider (OpenCode Zen): its free models run with no key. */
export const OPENCODE_ZEN_PROVIDER = 'opencode';
/** OpenCode Go: the subscription's models, listed once an account with it signs in. */
export const OPENCODE_GO_PROVIDER = 'opencode-go';
/** What a new session runs when nothing else is picked, while the CLI lists it. */
export const OPENCODE_DEFAULT_MODEL = `${OPENCODE_ZEN_PROVIDER}/big-pickle`;

export const OPENCODE_NOT_INSTALLED_REASON = 'The opencode CLI is not installed on this server.';

const DEFAULT_CATALOG_TTL_MS = 10 * 60_000;
const FAILED_PROBE_TTL_MS = 30_000;

const VARIANT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/** A model costs nothing to run (OpenCode lists its price as zero): a free model. */
export function isFreeOpenCodeModel(model: Pick<OpenCodeProviderModel, 'cost'>): boolean {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

/** A model's reasoning variants as the shared `effort` select; none when it has no variants. */
function variantDescriptor(model: OpenCodeProviderModel): ProviderOptionDescriptor | undefined {
  const variants = Object.keys(model.variants ?? {});
  if (variants.length === 0) return undefined;
  return {
    id: EFFORT_OPTION_ID,
    label: 'Reasoning',
    type: 'select',
    role: 'reasoning',
    options: variants.map(variant => ({ id: variant, label: VARIANT_LABELS[variant] ?? variant })),
  };
}

/**
 * The models a Factory can run on OpenCode: OpenCode Zen's free models (no key, no account), and,
 * once an OpenCode account signs in (`signedIn`), the paid Zen models and OpenCode Go's that its
 * server lists. Free ones are marked `free`: their providers may use what is sent to them to improve
 * their models, so a client's repository needs the client's consent first (ADR-0043). Deprecated
 * ones are left out.
 */
export function openCodeCatalogModels(list: OpenCodeProviderList, { signedIn = false }: { signedIn?: boolean } = {}): ServerProviderModel[] {
  const providers = signedIn ? [OPENCODE_ZEN_PROVIDER, OPENCODE_GO_PROVIDER] : [OPENCODE_ZEN_PROVIDER];
  return providers.flatMap(providerId => {
    const provider = list.all.find(candidate => candidate.id === providerId);
    if (!provider) return [];
    const models = Object.values(provider.models)
      .filter(model => model.status !== 'deprecated' && (signedIn || isFreeOpenCodeModel(model)))
      .sort((a, b) => Number(isFreeOpenCodeModel(b)) - Number(isFreeOpenCodeModel(a)) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
    return models.map(model => {
      const slug = `${providerId}/${model.id}`;
      const descriptor = variantDescriptor(model);
      return {
        slug,
        name: providerId === OPENCODE_GO_PROVIDER ? `${model.name ?? model.id} (Go)` : (model.name ?? model.id),
        ...(isFreeOpenCodeModel(model) ? { badge: 'free' as const } : {}),
        isCustom: false,
        ...(slug === OPENCODE_DEFAULT_MODEL ? { isDefault: true } : {}),
        capabilities: descriptor ? createModelCapabilities({ optionDescriptors: [descriptor] }) : null,
      };
    });
  });
}

/** What the facet knows about the CLI: whether it runs, and the models it offers. */
export interface OpenCodeCatalogState extends HarnessModelAvailability {
  readonly models: ServerProviderModel[];
  readonly version?: string;
}

/** The OpenCode account a catalog is listed for: its key, and a stable key to cache the list under (never the key itself). */
export interface OpenCodeCatalogAccount {
  readonly cacheKey: string;
  readonly apiKey: string;
}

/**
 * Where the facet reads the catalog from; cached by {@link createOpenCodeCatalogSource}. Without an
 * account it is the free models; with one, what that account's server lists.
 */
export type OpenCodeCatalogSource = (account?: OpenCodeCatalogAccount) => Promise<OpenCodeCatalogState>;

/**
 * The CLI's catalog, probed once and kept for `ttlMs`: the free models an `opencode serve` lists;
 * unavailable (with why) when the CLI is missing or cannot start.
 */
export function createOpenCodeCatalogSource(options: {
  /** Whether the `opencode` binary is there at all; asked before each probe. */
  installed: () => boolean | Promise<boolean>;
  /** Starts a server (signed in with the account's key, when given), lists its providers and stops it. */
  probe: (apiKey?: string) => Promise<{ providers: OpenCodeProviderList; version?: string }>;
  ttlMs?: number;
  now?: () => number;
}): OpenCodeCatalogSource & { invalidate(): void } {
  const now = options.now ?? Date.now;
  const cached = new Map<string, { state: OpenCodeCatalogState; until: number }>();
  const pending = new Map<string, Promise<OpenCodeCatalogState>>();

  const read = async (account: OpenCodeCatalogAccount | undefined): Promise<{ state: OpenCodeCatalogState; ttl: number }> => {
    if (!(await options.installed())) {
      return { state: { available: false, needsSetup: true, reason: OPENCODE_NOT_INSTALLED_REASON, models: [] }, ttl: FAILED_PROBE_TTL_MS };
    }
    try {
      const result = await options.probe(account?.apiKey);
      const models = openCodeCatalogModels(result.providers, { signedIn: account !== undefined });
      if (models.length === 0) {
        return {
          state: { available: false, reason: 'OpenCode lists no free models right now.', models: [], ...(result.version ? { version: result.version } : {}) },
          ttl: FAILED_PROBE_TTL_MS,
        };
      }
      return { state: { available: true, models, ...(result.version ? { version: result.version } : {}) }, ttl: options.ttlMs ?? DEFAULT_CATALOG_TTL_MS };
    } catch (error) {
      // What the server answered stays in the logs: a person reads the status, not the body.
      const reason = error instanceof OpenCodeHttpError ? `HTTP ${error.status}` : error instanceof Error ? error.message : String(error);
      if (error instanceof OpenCodeHttpError) console.warn('[opencode harness] The catalog probe failed.', error);
      return { state: { available: false, reason: `OpenCode could not list its models: ${reason}`, models: [] }, ttl: FAILED_PROBE_TTL_MS };
    }
  };

  const source = async (account?: OpenCodeCatalogAccount) => {
    const key = account?.cacheKey ?? '';
    const hit = cached.get(key);
    if (hit && hit.until > now()) return hit.state;
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = read(account)
        .then(({ state, ttl }) => {
          cached.set(key, { state, until: now() + ttl });
          return state;
        })
        .finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    return inFlight;
  };
  return Object.assign(source, {
    invalidate() {
      cached.clear();
    },
  });
}

/** The thread settings a session's selection lives in. */
interface SelectionSettings {
  getSetting(input: { key: string }): Promise<unknown>;
  setSetting(input: { key: string; value: unknown }): Promise<void>;
}

export interface OpenCodeHarnessModelsOptions<Session extends { thread: SelectionSettings }> {
  harnessId?: string;
  displayName?: string;
  owns(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /** The session's Factory default (its `harnessModelDefaults.opencode`), read per turn. */
  defaults(session: Session): Promise<ModelSelection | null>;
  /** The Factory default outside a session (Settings, a new chat of a Factory). */
  factoryDefaults?(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** Thread-setting keys: the session's own pick, and the selection its last turn ran. */
  settingKeys: { selection: string; lastSelection: string };
  catalog: OpenCodeCatalogSource;
  /**
   * The organization's OpenCode account the catalog is listed for (its paid models then show);
   * none lists the free models alone.
   */
  accountFor?(orgId: string): Promise<OpenCodeCatalogAccount | undefined>;
}

export interface OpenCodeHarnessModels<Session> extends HarnessModels {
  /** The fields for the session's next turn; remembers what it runs, so a switch marks the turn. */
  turnSelection(session: Session): Promise<OpenCodeTurnModelSelection>;
  /** The selection the session's next turn runs on, defaults filled in. */
  effectiveSelection(session: Session): Promise<ModelSelection | null>;
}

function parseSelection(value: unknown): ModelSelection | null {
  const parsed = ModelSelection.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** An OpenCode harness's models, as the Factory server registers them. */
export function createOpenCodeHarnessModels<Session extends { thread: SelectionSettings }>(
  options: OpenCodeHarnessModelsOptions<Session>,
): OpenCodeHarnessModels<Session> {
  const keys = options.settingKeys;
  /** The catalog a person of `ctx` picks from: their organization's account's, else the free one. */
  const catalogFor = async (ctx: HarnessModelContext) => {
    const account = ctx.viewer.orgId ? await options.accountFor?.(ctx.viewer.orgId) : undefined;
    return options.catalog(account);
  };
  const catalogDefault = async (): Promise<ModelSelection | null> => {
    const models = (await options.catalog()).models;
    const slug = (models.find(model => model.isDefault) ?? models[0])?.slug;
    return slug ? { instanceId: OPENCODE_INSTANCE_ID, model: slug } : null;
  };
  /** The session's pick, else its Factory's default, else the catalog's: what its next turn runs. */
  const effectiveSelection = async (session: Session): Promise<ModelSelection | null> =>
    parseSelection(await session.thread.getSetting({ key: keys.selection })) ?? (await options.defaults(session)) ?? (await catalogDefault());
  const factoryDefault = async (ctx: HarnessModelContext): Promise<ModelSelection | null> => {
    if (ctx.sessionId) {
      const session = await options.getSession(ctx.sessionId);
      if (session) return options.defaults(session);
    }
    return (await options.factoryDefaults?.(ctx)) ?? null;
  };

  return {
    instanceId: OPENCODE_INSTANCE_ID,
    harnessId: options.harnessId ?? OPENCODE_HARNESS_ID,
    displayName: options.displayName ?? 'OpenCode',
    owns: sessionId => options.owns(sessionId),
    async availability() {
      const { available, needsSetup, reason } = await options.catalog();
      return { available, ...(needsSetup ? { needsSetup } : {}), ...(reason ? { reason } : {}) };
    },
    list: async ctx => (await catalogFor(ctx)).models,
    catalogDefault,
    factoryDefault,
    async defaultSelection(ctx) {
      const session = ctx.sessionId ? await options.getSession(ctx.sessionId) : undefined;
      return resolveModelDefault({
        session: session ? await effectiveSelection(session) : null,
        factory: session ? null : await factoryDefault(ctx),
        catalog: await catalogDefault(),
      });
    },
    async check(request, ctx) {
      let selected: ProviderOptionSelection[] = [];
      if (request.options !== undefined) {
        const parsed = ProviderOptionSelections.safeParse(request.options);
        if (!parsed.success) return { ok: false, error: 'options must be a list of { id, value }.' };
        selected = [...parsed.data];
      }
      return checkModelSelection(OPENCODE_INSTANCE_ID, (await catalogFor(ctx)).models, { model: request.model, options: selected });
    },
    async getSelection(sessionId) {
      const session = await options.getSession(sessionId);
      return session ? effectiveSelection(session) : null;
    },
    // Each `prompt_async` names its model and variant, so a running turn finishes on its own.
    async setSelection(sessionId, selection): Promise<ModelSwitchResult> {
      const session = await options.getSession(sessionId);
      if (!session) return { ok: false, status: 404, error: 'That OpenCode session was not found.' };
      await session.thread.setSetting({ key: keys.selection, value: selection });
      return { ok: true, modelSelection: await effectiveSelection(session), appliesFrom: 'next-turn' };
    },
    async turnSelection(session) {
      const selection = await effectiveSelection(session);
      const last = parseSelection(await session.thread.getSetting({ key: keys.lastSelection }));
      if (selection && !(last && modelSelectionsEqual(last, selection))) {
        await session.thread.setSetting({ key: keys.lastSelection, value: selection });
      }
      const variant = selection ? getModelSelectionStringOptionValue(selection, EFFORT_OPTION_ID) : undefined;
      return {
        ...(selection?.model ? { model: selection.model } : {}),
        ...(variant ? { variant } : {}),
        ...modelSwitchBetween(last, selection),
      };
    },
    effectiveSelection,
  };
}
