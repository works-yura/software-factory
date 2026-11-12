// The model facet of the harness contract: what a harness tells the Factory about the models its
// sessions run, and how a session's pick is checked and applied. The server, the chat and the agent
// tools only go through this; they never know which harness answers.
import type { ModelSelection, ProviderOptionSelection, ServerProviderModel } from './contracts.ts';
import type { ModelSelectionCheck } from './selection.ts';

/** Who asks, and about what: a session's catalog can depend on its owner's or its Factory's credentials. */
export interface HarnessModelContext {
  /** The person asking; empty ids when the server runs without auth. */
  readonly viewer: { readonly userId: string; readonly orgId: string };
  /** The session the question is about, when there is one. */
  readonly sessionId?: string;
  /** The Factory the question is about, outside any session (Settings, a new chat). */
  readonly factoryProjectId?: string;
}

/** A pick as the chat route and the agent tool send it. */
export interface ModelSwitchRequest {
  /** A model of the harness's catalog (slug or alias); null clears the session's own pick, back to its defaults. */
  readonly model: string | null;
  /** `[{ id, value }]`, checked against the model's option descriptors. */
  readonly options?: ReadonlyArray<ProviderOptionSelection>;
  /**
   * Mastra's thinking level (`off`…`max`), which older clients and the agent tool send beside the
   * model. A harness reads it as its reasoning option unless `options` names one.
   */
  readonly thinkingLevel?: string;
  /**
   * The instance the client picked from. A pick on another harness's instance moves the session to
   * that harness with a context handoff (`@factory/harness-handoff`) where the server wires one
   * (`HarnessSwitch`); elsewhere it is refused.
   */
  readonly instanceId?: string;
}

export type ModelSwitchResult =
  | {
      readonly ok: true;
      /** What the session runs from now on, defaults filled in; null leaves the harness's own default. */
      readonly modelSelection: ModelSelection | null;
      /** `now`: a live session switched; `next-turn`: its next turn (or run) picks it up. */
      readonly appliesFrom: 'now' | 'next-turn';
      /** Set when the pick moved the session to another harness: its next turn carries the handoff. */
      readonly handoff?: SessionHarnessHandoff;
    }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 503; readonly error: string };

/** A session's move to another harness, as a switch reports it. */
export interface SessionHarnessHandoff {
  readonly id: string;
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  /** The harness the session runs on from now (`HarnessModels.harnessId`). */
  readonly harnessId: string;
}

export interface HarnessModelAvailability {
  readonly available: boolean;
  /** Why not, for the picker (no credential yet, the CLI is missing, …). */
  readonly reason?: string;
  /** Nothing is configured yet: the picker offers the provider setup instead of models. */
  readonly needsSetup?: boolean;
}

/**
 * The models of one harness instance. A harness that offers model choice implements it and the
 * Factory lists it in `/web/config/models`, routes `POST …/sessions/:id/model` and
 * `factory_switch_session_model` to it, and labels switches with its descriptors.
 */
export interface HarnessModels {
  /** `ModelSelection.instanceId` of every selection this facet makes (`mastra`, `claude-code`, `codex`). */
  readonly instanceId: string;
  /** The harness that runs it (`HarnessDescriptor.id`): a pick on another harness needs a new session. */
  readonly harnessId: string;
  readonly displayName: string;
  /**
   * The connector in Settings › Підключення whose connections this harness runs on (ADR-0036: its
   * members' sign-ins). Absent: it needs none. The UI links "connect an agent" there by this id.
   */
  readonly connector?: string;
  /**
   * Whether this harness runs the session. Asked in registration order; the server's default
   * harness answers true for everything and goes last.
   */
  owns(sessionId: string): Promise<boolean>;
  /** Absent: always available. */
  availability?(ctx: HarnessModelContext): Promise<HarnessModelAvailability>;
  /** The models a session (or a Factory, outside one) can run, with their option descriptors. */
  list(ctx: HarnessModelContext): Promise<ServerProviderModel[]>;
  /**
   * What a session starts on: in a session, what it runs; outside one, the Factory's default for this
   * instance (`factoryDefault`), else the catalog's (`catalogDefault`). Null when the harness picks itself.
   */
  defaultSelection(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** The harness's own default for `ctx`, with no Factory default set: what "Use catalog default" means. */
  catalogDefault(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /**
   * The Factory's default for this instance (`harnessModelDefaults[instanceId]` of the session's or
   * `ctx.factoryProjectId`'s Factory); null when it follows the catalog default. Absent: never set.
   */
  factoryDefault?(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /**
   * A request checked against the catalog `ctx` addresses: the selection to store, or why not.
   * Outside a session (a Factory default from Settings) it checks against the Factory's catalog.
   */
  check(request: ModelSwitchRequest & { readonly model: string }, ctx: HarnessModelContext): Promise<ModelSelectionCheck>;
  /** The selection the session runs now (or from its next turn); null when it follows the harness default. */
  getSelection(sessionId: string, ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** Applies a checked selection (null: clear the session's own pick). */
  setSelection(sessionId: string, selection: ModelSelection | null, ctx: HarnessModelContext): Promise<ModelSwitchResult>;
  /**
   * Moves the Factory's running sessions onto `selection` (Settings offers it after a new default).
   * Absent: sessions pick a new default up on their own, from their next turn.
   */
  applyDefaultToRunningSessions?(
    selection: ModelSelection,
    ctx: HarnessModelContext & {
      readonly factoryProjectId: string;
      /** False once the Factory's default moved on: the facet stops switching sessions to this one. */
      readonly stillCurrent?: () => Promise<boolean>;
    },
  ): Promise<RunningSessionsApplyResult>;
}

/** What `applyDefaultToRunningSessions` switched: thread ids, and the ones it left with why. */
export interface RunningSessionsApplyResult {
  applied: string[];
  skipped: Array<{ threadId: string; reason: string }>;
}

/** One instance as `/web/config/models` lists it under `instances`. */
export interface HarnessModelInstanceInfo {
  instanceId: string;
  harnessId: string;
  displayName: string;
  /** Usable for the viewer: a harness that is not is offered nowhere (pickers, the harness switch, a new Factory). */
  available: boolean;
  needsSetup: boolean;
  /** Why not, in words, when unavailable. */
  reason?: string;
  /** The connector to connect for it to become available (`HarnessModels.connector`). */
  connector?: string;
  /** The model a new session starts on (`defaultSelection`), when the harness names one. */
  defaultModel: string | null;
  defaultSelection: ModelSelection | null;
  /** The Factory's own default for this instance; null when it follows `catalogDefaultSelection`. */
  factoryDefaultSelection: ModelSelection | null;
  /** The harness's default when the Factory sets none. */
  catalogDefaultSelection: ModelSelection | null;
  /** The facet can move running sessions onto a new default (`applyDefaultToRunningSessions`). */
  appliesToRunningSessions: boolean;
  /**
   * A session of another harness can be moved onto this instance (a model switch with a context
   * handoff); absent or false, a pick here from another harness's session needs a new chat.
   */
  acceptsHandoff?: boolean;
  models: ServerProviderModel[];
}

/**
 * The facet of a harness whose sessions run on connections (ADR-0036): available to a viewer only
 * when `missing` says nothing is (a sign-in they may use, now or after a reset), and named by its
 * connector so the UI can send the person there. The facet's own availability is asked first.
 */
export function withConnectionAvailability<Models extends HarnessModels>(
  models: Models,
  connection: { readonly connector: string; missing?(ctx: HarnessModelContext): Promise<string | undefined> },
): Models {
  const inner = models.availability?.bind(models);
  return Object.assign(Object.create(Object.getPrototypeOf(models) as object) as Models, models, {
    connector: connection.connector,
    async availability(ctx: HarnessModelContext): Promise<HarnessModelAvailability> {
      const own = (await inner?.(ctx)) ?? { available: true };
      if (!own.available || !connection.missing) return own;
      const missing = await connection.missing(ctx);
      return missing ? { available: false, needsSetup: true, reason: missing } : own;
    },
  });
}
