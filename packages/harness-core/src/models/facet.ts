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
   * The instance the client picked from. A pick on another harness's instance is refused: moving a
   * session between harnesses is a handoff (`@factory/harness-handoff`), not a model switch.
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
    }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 503; readonly error: string };

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
   * Whether this harness runs the session. Asked in registration order; the server's default
   * harness answers true for everything and goes last.
   */
  owns(sessionId: string): Promise<boolean>;
  /** Absent: always available. */
  availability?(ctx: HarnessModelContext): Promise<HarnessModelAvailability>;
  /** The models a session (or a Factory, outside one) can run, with their option descriptors. */
  list(ctx: HarnessModelContext): Promise<ServerProviderModel[]>;
  /** What a new session starts on, or the session's defaults; null when the harness picks itself. */
  defaultSelection(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** A request checked against the catalog `ctx` addresses: the selection to store, or why not. */
  check(request: ModelSwitchRequest & { readonly model: string }, ctx: HarnessModelContext): Promise<ModelSelectionCheck>;
  /** The selection the session runs now (or from its next turn); null when it follows the harness default. */
  getSelection(sessionId: string, ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** Applies a checked selection (null: clear the session's own pick). */
  setSelection(sessionId: string, selection: ModelSelection | null, ctx: HarnessModelContext): Promise<ModelSwitchResult>;
}

/** One instance as `/web/config/models` lists it under `instances`. */
export interface HarnessModelInstanceInfo {
  instanceId: string;
  harnessId: string;
  displayName: string;
  available: boolean;
  needsSetup: boolean;
  reason?: string;
  /** The model a new session starts on (`defaultSelection`), when the harness names one. */
  defaultModel: string | null;
  defaultSelection: ModelSelection | null;
  models: ServerProviderModel[];
}
