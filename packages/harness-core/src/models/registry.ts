// The server's harnesses, as their model facets: one place lists their catalogs and routes a
// session's model switch to the harness that runs it, so nothing above it branches on a harness.
import type {
  HarnessModelContext,
  HarnessModelInstanceInfo,
  HarnessModels,
  ModelSwitchRequest,
  ModelSwitchResult,
} from './facet.ts';

/**
 * Moves a session to another harness: what a pick on another harness's instance does where the
 * server wires a context handoff (`@factory/harness-handoff`). Without one, such a pick is refused.
 */
export interface HarnessSwitch {
  /** Whether a session of `fromInstanceId` can move onto `toInstanceId`. */
  accepts(toInstanceId: string, fromInstanceId?: string): boolean;
  /** Plans and makes the move, the pick applied on the target; refusals as a facet's. */
  switchHarness(input: {
    readonly sessionId: string;
    readonly from: HarnessModels;
    readonly to: HarnessModels;
    readonly request: ModelSwitchRequest;
    readonly ctx: HarnessModelContext;
  }): Promise<ModelSwitchResult>;
}

export interface HarnessModelRegistry {
  /** Adds a harness's facet. A `fallback` one (the server's default harness) is asked last. */
  register(models: HarnessModels, options?: { fallback?: boolean }): void;
  /** Every facet, in the order sessions are routed. */
  all(): HarnessModels[];
  forInstance(instanceId: string): HarnessModels | undefined;
  /** The facet of the harness that runs the session. */
  forSession(sessionId: string): Promise<HarnessModels | undefined>;
  /**
   * Every instance with its catalog, for `/web/config/models`: the default harness first. `described`
   * are instances the caller already resolved itself (their facets are not asked again).
   */
  describe(ctx: HarnessModelContext, described?: ReadonlyArray<HarnessModelInstanceInfo>): Promise<HarnessModelInstanceInfo[]>;
  /** Wires the move between harnesses a cross-harness pick makes; unset, such picks are refused. */
  setHarnessSwitch(handler: HarnessSwitch | undefined): void;
  /**
   * Checks a pick against the session's harness and applies it: the chat route and the agent tool.
   * A pick on another harness's instance goes to the {@link HarnessSwitch}.
   */
  switchSessionModel(sessionId: string, request: ModelSwitchRequest, ctx: HarnessModelContext): Promise<ModelSwitchResult>;
}

/** Describes one facet's instance for `ctx`; a failing catalog lists the instance as unavailable. */
export async function describeHarnessModels(models: HarnessModels, ctx: HarnessModelContext): Promise<HarnessModelInstanceInfo> {
  const base = {
    instanceId: models.instanceId,
    harnessId: models.harnessId,
    displayName: models.displayName,
    ...(models.connector ? { connector: models.connector } : {}),
  };
  try {
    const availability = (await models.availability?.(ctx)) ?? { available: true };
    // The Factory's own default reads even when the harness is unavailable, so Settings still shows it.
    const factoryDefault = (await models.factoryDefault?.(ctx)) ?? null;
    const [list, defaultSelection, catalogDefault] = availability.available
      ? await Promise.all([models.list(ctx), models.defaultSelection(ctx), models.catalogDefault(ctx)])
      : [[], null, null];
    return {
      ...base,
      available: availability.available && list.length > 0,
      needsSetup: availability.needsSetup ?? false,
      ...(availability.reason ? { reason: availability.reason } : {}),
      defaultModel: defaultSelection?.model ?? null,
      defaultSelection,
      factoryDefaultSelection: factoryDefault,
      catalogDefaultSelection: catalogDefault,
      appliesToRunningSessions: models.applyDefaultToRunningSessions !== undefined,
      models: list,
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      needsSetup: false,
      reason: error instanceof Error ? error.message : String(error),
      defaultModel: null,
      defaultSelection: null,
      factoryDefaultSelection: null,
      catalogDefaultSelection: null,
      appliesToRunningSessions: false,
      models: [],
    };
  }
}

export function createHarnessModelRegistry(initial: ReadonlyArray<HarnessModels> = []): HarnessModelRegistry {
  const routed: HarnessModels[] = [...initial];
  const fallbacks: HarnessModels[] = [];
  const all = () => [...routed, ...fallbacks];
  let harnessSwitch: HarnessSwitch | undefined;

  const registry: HarnessModelRegistry = {
    register(models, options) {
      if (all().some(existing => existing.instanceId === models.instanceId)) {
        throw new Error(`A harness already registered model instance ${models.instanceId}.`);
      }
      (options?.fallback ? fallbacks : routed).push(models);
    },
    all,
    forInstance: instanceId => all().find(models => models.instanceId === instanceId),
    async forSession(sessionId) {
      for (const models of all()) {
        if (await models.owns(sessionId)) return models;
      }
      return undefined;
    },
    // The server's default harness first, as pickers list it; then the others in registration order.
    async describe(ctx, described = []) {
      const known = new Map(described.map(info => [info.instanceId, info]));
      const facets = [...fallbacks, ...routed];
      const extra = described.filter(info => !facets.some(models => models.instanceId === info.instanceId));
      const infos = [
        ...extra,
        ...(await Promise.all(facets.map(models => known.get(models.instanceId) ?? describeHarnessModels(models, ctx)))),
      ];
      return harnessSwitch ? infos.map(info => ({ ...info, acceptsHandoff: harnessSwitch!.accepts(info.instanceId) })) : infos;
    },
    setHarnessSwitch(handler) {
      harnessSwitch = handler;
    },
    async switchSessionModel(sessionId, request, ctx) {
      const models = await registry.forSession(sessionId);
      if (!models) return { ok: false, status: 404, error: "That session's harness can't switch models on this server." };
      if (request.instanceId && request.instanceId !== models.instanceId) {
        const target = registry.forInstance(request.instanceId);
        if (target && harnessSwitch?.accepts(target.instanceId, models.instanceId)) {
          return harnessSwitch.switchHarness({ sessionId, from: models, to: target, request, ctx });
        }
        return {
          ok: false,
          status: 409,
          error: `This session runs on ${models.displayName}; a ${request.instanceId} model needs a new session (switching harnesses is a handoff, not a model switch).`,
        };
      }
      const sessionCtx = { ...ctx, sessionId };
      if (request.model === null) return models.setSelection(sessionId, null, sessionCtx);
      const checked = await models.check({ ...request, model: request.model }, sessionCtx);
      if (!checked.ok) return { ok: false, status: 400, error: checked.error };
      return models.setSelection(sessionId, checked.selection, sessionCtx);
    },
  };
  return registry;
}
