import {
  FACTORY_GITHUB_EVENTS,
  FACTORY_GITLAB_EVENTS,
} from '../rules/types.ts';
import type {
  FactoryGithubEventName,
  FactoryGithubRuleContext,
  FactoryGitLabEventName,
  FactoryGitLabRuleContext,
  FactoryRuleHandler,
  FactoryRuleSource,
  FactoryStageRuleContext,
  FactoryToolResultRuleContext,
} from '../rules/types.ts';
import { isPlainObject } from '../plain-object.ts';
import { isBoardIdentifier, isIdentifier, MAX_ROLE_LENGTH, MAX_TOOL_NAME_LENGTH } from '../rules/validation.ts';
import type { BoardTransitionPolicy } from './transition-policy.ts';

type BoardPhaseHandlers = Partial<Record<FactoryRuleSource, FactoryRuleHandler<FactoryStageRuleContext>>>;
type ReadonlyBoardPhaseHandlers = Readonly<BoardPhaseHandlers>;

/** Runs when an agent seated on this board completes the named tool. */
export type BoardToolResultRuleHandler = FactoryRuleHandler<FactoryToolResultRuleContext>;
export type BoardToolRule = { readonly onResult: BoardToolResultRuleHandler };
export type BoardToolRules = Readonly<Record<string, BoardToolRule>>;

/**
 * A board's handler for one integration event. `null` switches the integration default off
 * for cards on this board only.
 */
type BoardEventHandlerMap<EventName extends string, Context> = Readonly<
  Partial<Record<EventName, FactoryRuleHandler<Context> | null>>
>;

/**
 * How cards on this board react to integration events, keyed by integration then event.
 * Consulted for events bound to a card on this board, after any handler the deployment set
 * explicitly on the integration and before the integration default.
 */
export interface BoardEventRules {
  readonly github?: BoardEventHandlerMap<FactoryGithubEventName, FactoryGithubRuleContext>;
  readonly gitlab?: BoardEventHandlerMap<FactoryGitLabEventName, FactoryGitLabRuleContext>;
}
export type BoardEventIntegration = keyof BoardEventRules;

const BOARD_EVENT_NAMES: Readonly<Record<BoardEventIntegration, readonly string[]>> = {
  github: FACTORY_GITHUB_EVENTS,
  gitlab: FACTORY_GITLAB_EVENTS,
};

type ReadonlyFactoryBoardRules = Readonly<
  Record<
    string,
    Readonly<
      Partial<
        Record<
          FactoryRuleSource,
          Readonly<{
            onEnter?: FactoryRuleHandler<FactoryStageRuleContext>;
            onExit?: FactoryRuleHandler<FactoryStageRuleContext>;
          }>
        >
      >
    >
  >
>;

/**
 * What a phase means to the runtime.
 * - `resting`: nobody is seated; a card waits for a person or an event.
 * - `working`: an agent in `role` carries the card; a person's move in arms autonomy.
 * - `terminal`: the card is finished; sessions stop and held resources are released.
 */
export type BoardPhaseKind = 'resting' | 'working' | 'terminal';

type BoardPhaseBase<PhaseId extends string> = {
  readonly title: string;
  readonly next?: PhaseId;
  readonly outcomes?: Readonly<Record<string, PhaseId>>;
  readonly onEnter?: ReadonlyBoardPhaseHandlers;
  readonly onExit?: ReadonlyBoardPhaseHandlers;
};

export type BoardPhaseDefinition<PhaseId extends string> =
  | (BoardPhaseBase<PhaseId> & { readonly kind: 'resting'; readonly role?: never })
  | (BoardPhaseBase<PhaseId> & { readonly kind: 'working'; readonly role: string })
  | (BoardPhaseBase<PhaseId> & { readonly kind: 'terminal'; readonly role?: never });

export interface BoardTransition<PhaseId extends string> {
  readonly outcome: string | null;
  readonly to: PhaseId;
}

/**
 * Terminal phases a card moves to when its tracked source (issue or follow-up) closes.
 * `completed` is used when the source was completed, `canceled` when it was canceled or not planned.
 */
export type BoardSourceClosed<PhaseId extends string> = Readonly<{ completed: PhaseId; canceled: PhaseId }>;

/**
 * How a board's cards ship code through change requests (pull or merge requests), the way Work
 * does. The builder seated in `build` opens the change request; the card waits in `review` while
 * it is out (with self-review on, an independent `review` seat approves the branch there first);
 * the merge moves the card to `merged`. Declaring it opts the board into the change-request
 * behaviour the runtime and integration defaults otherwise keep for Work: the authoring card moves
 * out for review when its change request opens and closes on merge, review feedback wakes the
 * builder, and self-review records its verdict on the card.
 */
export type BoardChangeRequests<PhaseId extends string> = Readonly<{ build: PhaseId; review: PhaseId; merged: PhaseId }>;

/**
 * A reproduction test written in its own phase and protected in a later one. The seat in `record`
 * commits a failing test and records the commit and test paths on the card
 * (`factory_record_reproduction_test`); the seat in `protect` fixes the code and cannot move the
 * card on to a working phase while its checkout changes those paths since the recorded commit.
 */
export type BoardReproductionTest<PhaseId extends string> = Readonly<{ record: PhaseId; protect: PhaseId }>;

export interface BoardDefinition<BoardId extends string, PhaseId extends string> {
  readonly id: BoardId;
  readonly title: string;
  readonly initialPhase: PhaseId;
  readonly phases: Readonly<Record<PhaseId, BoardPhaseDefinition<PhaseId>>>;
  readonly transitions: Readonly<Record<PhaseId, readonly BoardTransition<PhaseId>[]>>;
  readonly rules: ReadonlyFactoryBoardRules;
  /** Tool-result rules keyed by tool name; empty when the board declares none. */
  readonly tools: BoardToolRules;
  /** Integration event handlers for cards on this board; empty when the board declares none. */
  readonly events: BoardEventRules;
  readonly transitionPolicy?: BoardTransitionPolicy;
  /** Where source-closed rules move a card; absent when the board opts out of auto-closing. */
  readonly sourceClosed?: BoardSourceClosed<PhaseId>;
  /** How the board's cards ship code; absent when they never open change requests. */
  readonly changeRequests?: BoardChangeRequests<PhaseId>;
  /** Where a reproduction test is recorded and where it is protected; absent when the board has none. */
  readonly reproductionTest?: BoardReproductionTest<PhaseId>;
  /**
   * Whether the board's `triage` seat reports a structured classification with every transition
   * it requests. The board's transition policy decides what each classification may do.
   */
  readonly triageClassification?: true;
  allowsTransition(from: PhaseId, to: PhaseId): boolean;
  /** Declared kind of a phase, or undefined when the board has no such phase. */
  phaseKind(phase: string): BoardPhaseKind | undefined;
  isWorking(phase: string): boolean;
  isTerminal(phase: string): boolean;
  /** Role seated in a working phase; undefined for resting/terminal/unknown phases. */
  roleForPhase(phase: string): string | undefined;
  /** First working phase, in declaration order, carried by `role`. */
  phaseForRole(role: string): PhaseId | undefined;
}

type BoardConfig<BoardId extends string, Phases extends Record<string, BoardPhaseDefinition<keyof Phases & string>>> = {
  id: BoardId;
  title: string;
  initialPhase: keyof Phases & string;
  phases: Phases;
  tools?: Record<string, BoardToolRule>;
  events?: BoardEventRules;
  transitionPolicy?: BoardTransitionPolicy;
  sourceClosed?: { completed: keyof Phases & string; canceled: keyof Phases & string };
  changeRequests?: { build: keyof Phases & string; review: keyof Phases & string; merged: keyof Phases & string };
  triageClassification?: boolean;
  reproductionTest?: { record: keyof Phases & string; protect: keyof Phases & string };
};

export class BoardDefinitionError extends Error {
  override name = 'BoardDefinitionError';
}

const PHASE_KINDS: ReadonlySet<string> = new Set<BoardPhaseKind>(['resting', 'working', 'terminal']);

function validateBoardIdentifier(value: unknown, label: string): void {
  if (!isBoardIdentifier(value)) {
    throw new BoardDefinitionError(`${label} must be a valid board identifier.`);
  }
}

function validatePhaseSemantics(phaseId: string, phase: BoardPhaseDefinition<string>): void {
  if (!PHASE_KINDS.has(phase.kind as string)) {
    throw new BoardDefinitionError(`Phase "${phaseId}" must declare kind 'resting', 'working', or 'terminal'.`);
  }
  if (phase.kind === 'working') {
    if (!isIdentifier(phase.role, MAX_ROLE_LENGTH)) {
      throw new BoardDefinitionError(`Working phase "${phaseId}" must declare a valid role.`);
    }
  } else if ((phase as { role?: unknown }).role !== undefined) {
    throw new BoardDefinitionError(`Phase "${phaseId}" is ${phase.kind} and cannot declare a role.`);
  }
}

function validateToolRules(tools: unknown): BoardToolRules {
  if (tools === undefined) return Object.freeze({});
  if (!isPlainObject(tools)) throw new BoardDefinitionError('Board tools must be a plain object.');
  const frozen: Record<string, BoardToolRule> = {};
  for (const [toolName, leaf] of Object.entries(tools)) {
    if (!isIdentifier(toolName, MAX_TOOL_NAME_LENGTH)) {
      throw new BoardDefinitionError(`Tool rule "${toolName}" has an invalid tool name.`);
    }
    if (!isPlainObject(leaf) || Object.keys(leaf).some(key => key !== 'onResult')) {
      throw new BoardDefinitionError(`Tool rule "${toolName}" must be an object with only onResult.`);
    }
    if (typeof leaf.onResult !== 'function') {
      throw new BoardDefinitionError(`Tool rule "${toolName}" must declare an onResult function.`);
    }
    frozen[toolName] = Object.freeze({ onResult: leaf.onResult as BoardToolResultRuleHandler });
  }
  return Object.freeze(frozen);
}

function validateSourceClosed(
  sourceClosed: unknown,
  phases: Readonly<Record<string, BoardPhaseDefinition<string>>>,
): BoardSourceClosed<string> | undefined {
  if (sourceClosed === undefined) return undefined;
  if (!isPlainObject(sourceClosed)) throw new BoardDefinitionError('Board sourceClosed must be a plain object.');
  const keys = Object.keys(sourceClosed);
  if (keys.length !== 2 || !keys.includes('completed') || !keys.includes('canceled')) {
    throw new BoardDefinitionError('Board sourceClosed must declare exactly completed and canceled.');
  }
  for (const key of ['completed', 'canceled'] as const) {
    const phase = sourceClosed[key];
    if (typeof phase !== 'string' || !Object.hasOwn(phases, phase) || phases[phase]!.kind !== 'terminal') {
      throw new BoardDefinitionError(`Board sourceClosed.${key} "${String(phase)}" must name a terminal phase.`);
    }
  }
  return Object.freeze({ completed: sourceClosed.completed as string, canceled: sourceClosed.canceled as string });
}

function validateChangeRequests(
  changeRequests: unknown,
  phases: Readonly<Record<string, BoardPhaseDefinition<string>>>,
): BoardChangeRequests<string> | undefined {
  if (changeRequests === undefined) return undefined;
  if (!isPlainObject(changeRequests)) throw new BoardDefinitionError('Board changeRequests must be a plain object.');
  const keys = Object.keys(changeRequests);
  const expected = { build: 'working', review: 'working', merged: 'terminal' } as const;
  if (keys.length !== 3 || !keys.every(key => Object.hasOwn(expected, key))) {
    throw new BoardDefinitionError('Board changeRequests must declare exactly build, review, and merged.');
  }
  for (const [key, kind] of Object.entries(expected)) {
    const phase = changeRequests[key];
    if (typeof phase !== 'string' || !Object.hasOwn(phases, phase) || phases[phase]!.kind !== kind) {
      throw new BoardDefinitionError(`Board changeRequests.${key} "${String(phase)}" must name a ${kind} phase.`);
    }
  }
  return Object.freeze({
    build: changeRequests.build as string,
    review: changeRequests.review as string,
    merged: changeRequests.merged as string,
  });
}

function validateReproductionTest(
  reproductionTest: unknown,
  phases: Readonly<Record<string, BoardPhaseDefinition<string>>>,
): BoardReproductionTest<string> | undefined {
  if (reproductionTest === undefined) return undefined;
  if (!isPlainObject(reproductionTest)) throw new BoardDefinitionError('Board reproductionTest must be a plain object.');
  const keys = Object.keys(reproductionTest);
  if (keys.length !== 2 || !keys.includes('record') || !keys.includes('protect')) {
    throw new BoardDefinitionError('Board reproductionTest must declare exactly record and protect.');
  }
  for (const key of ['record', 'protect'] as const) {
    const phase = reproductionTest[key];
    if (typeof phase !== 'string' || !Object.hasOwn(phases, phase) || phases[phase]!.kind !== 'working') {
      throw new BoardDefinitionError(`Board reproductionTest.${key} "${String(phase)}" must name a working phase.`);
    }
  }
  if (reproductionTest.record === reproductionTest.protect) {
    throw new BoardDefinitionError('Board reproductionTest must record and protect in different phases.');
  }
  return Object.freeze({ record: reproductionTest.record as string, protect: reproductionTest.protect as string });
}

function validateEventRules(events: unknown): BoardEventRules {
  if (events === undefined) return Object.freeze({});
  if (!isPlainObject(events)) throw new BoardDefinitionError('Board events must be a plain object.');
  const frozen: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [integration, handlers] of Object.entries(events)) {
    const known = Object.hasOwn(BOARD_EVENT_NAMES, integration)
      ? BOARD_EVENT_NAMES[integration as BoardEventIntegration]
      : undefined;
    if (!known) throw new BoardDefinitionError(`Board events name unknown integration "${integration}".`);
    if (handlers === undefined) continue;
    if (!isPlainObject(handlers)) {
      throw new BoardDefinitionError(`Board events for "${integration}" must be a plain object.`);
    }
    const entries: Record<string, unknown> = {};
    for (const [event, handler] of Object.entries(handlers)) {
      if (!known.includes(event)) {
        throw new BoardDefinitionError(`Board events for "${integration}" name unknown event "${event}".`);
      }
      if (handler === undefined) continue;
      if (handler !== null && typeof handler !== 'function') {
        throw new BoardDefinitionError(`Board event handler "${integration}.${event}" must be a function or null.`);
      }
      entries[event] = handler;
    }
    frozen[integration] = Object.freeze(entries);
  }
  return Object.freeze(frozen) as BoardEventRules;
}

export function defineBoard<
  const BoardId extends string,
  const Phases extends Record<string, BoardPhaseDefinition<keyof Phases & string>>,
>(config: BoardConfig<BoardId, Phases>): BoardDefinition<BoardId, keyof Phases & string> {
  type PhaseId = keyof Phases & string;
  validateBoardIdentifier(config.id, 'Board id');
  if (config.transitionPolicy !== undefined && typeof config.transitionPolicy !== 'function') {
    throw new BoardDefinitionError('Board transitionPolicy must be a function.');
  }
  const tools = validateToolRules(config.tools);
  const events = validateEventRules(config.events);
  const phaseIds = new Set(Object.keys(config.phases));
  if (phaseIds.size === 0) throw new BoardDefinitionError('A board must define at least one phase.');
  if (!phaseIds.has(config.initialPhase)) {
    throw new BoardDefinitionError(`Initial phase "${config.initialPhase}" is not defined.`);
  }
  for (const [phaseId, phase] of Object.entries(config.phases)) {
    validateBoardIdentifier(phaseId, 'Phase id');
    validatePhaseSemantics(phaseId, phase);
  }
  if (config.phases[config.initialPhase]!.kind !== 'resting') {
    throw new BoardDefinitionError(`Initial phase "${config.initialPhase}" must be a resting phase.`);
  }
  const sourceClosed = validateSourceClosed(config.sourceClosed, config.phases) as
    | BoardSourceClosed<PhaseId>
    | undefined;
  const changeRequests = validateChangeRequests(config.changeRequests, config.phases) as
    | BoardChangeRequests<PhaseId>
    | undefined;
  const reproductionTest = validateReproductionTest(config.reproductionTest, config.phases) as
    | BoardReproductionTest<PhaseId>
    | undefined;
  if (config.triageClassification !== undefined && typeof config.triageClassification !== 'boolean') {
    throw new BoardDefinitionError('Board triageClassification must be a boolean.');
  }

  const transitions = Object.fromEntries(
    Object.entries(config.phases).map(([phaseId, phase]) => {
      if (phase.next !== undefined && phase.outcomes) {
        throw new BoardDefinitionError(`Phase "${phaseId}" cannot define both next and outcomes.`);
      }
      const targets: BoardTransition<string>[] =
        phase.next !== undefined
          ? [Object.freeze({ outcome: null, to: phase.next })]
          : Object.entries(phase.outcomes ?? {}).map(([outcome, to]) => Object.freeze({ outcome, to }));
      for (const { to } of targets) {
        if (!phaseIds.has(to)) {
          throw new BoardDefinitionError(`Phase "${phaseId}" targets undefined phase "${to}".`);
        }
      }
      return [phaseId, Object.freeze(targets)];
    }),
  ) as Record<PhaseId, readonly BoardTransition<PhaseId>[]>;

  const phases = Object.freeze(
    Object.fromEntries(
      Object.entries(config.phases).map(([phaseId, phase]) => [
        phaseId,
        Object.freeze({
          title: phase.title,
          kind: phase.kind,
          ...(phase.kind === 'working' ? { role: phase.role } : {}),
          ...(phase.next !== undefined ? { next: phase.next } : {}),
          ...(phase.outcomes ? { outcomes: Object.freeze({ ...phase.outcomes }) } : {}),
          ...(phase.onEnter ? { onEnter: Object.freeze({ ...phase.onEnter }) } : {}),
          ...(phase.onExit ? { onExit: Object.freeze({ ...phase.onExit }) } : {}),
        }),
      ]),
    ),
  ) as Readonly<Record<PhaseId, BoardPhaseDefinition<PhaseId>>>;
  const rules = Object.freeze(
    Object.fromEntries(
      Object.entries(config.phases).flatMap(([phaseId, phase]) => {
        const sources = new Set([...Object.keys(phase.onEnter ?? {}), ...Object.keys(phase.onExit ?? {})]);
        if (sources.size === 0) return [];
        return [
          [
            phaseId,
            Object.freeze(
              Object.fromEntries(
                [...sources].map(source => [
                  source,
                  Object.freeze({
                    ...(phase.onEnter?.[source as FactoryRuleSource]
                      ? { onEnter: phase.onEnter[source as FactoryRuleSource] }
                      : {}),
                    ...(phase.onExit?.[source as FactoryRuleSource]
                      ? { onExit: phase.onExit[source as FactoryRuleSource] }
                      : {}),
                  }),
                ]),
              ),
            ),
          ],
        ];
      }),
    ),
  ) as ReadonlyFactoryBoardRules;

  const kinds = new Map<string, BoardPhaseKind>();
  const roles = new Map<string, string>();
  const phaseByRole = new Map<string, PhaseId>();
  for (const [phaseId, phase] of Object.entries(phases) as [PhaseId, BoardPhaseDefinition<PhaseId>][]) {
    kinds.set(phaseId, phase.kind);
    if (phase.kind !== 'working') continue;
    roles.set(phaseId, phase.role);
    if (!phaseByRole.has(phase.role)) phaseByRole.set(phase.role, phaseId);
  }

  return Object.freeze({
    id: config.id,
    title: config.title,
    initialPhase: config.initialPhase,
    phases,
    transitions: Object.freeze(transitions),
    rules,
    tools,
    events,
    ...(config.transitionPolicy ? { transitionPolicy: config.transitionPolicy } : {}),
    ...(sourceClosed ? { sourceClosed } : {}),
    ...(changeRequests ? { changeRequests } : {}),
    ...(reproductionTest ? { reproductionTest } : {}),
    ...(config.triageClassification === true ? { triageClassification: true as const } : {}),
    allowsTransition(from: PhaseId, to: PhaseId) {
      return from === to || transitions[from]?.some(transition => transition.to === to) === true;
    },
    phaseKind: (phase: string) => kinds.get(phase),
    isWorking: (phase: string) => kinds.get(phase) === 'working',
    isTerminal: (phase: string) => kinds.get(phase) === 'terminal',
    roleForPhase: (phase: string) => roles.get(phase),
    phaseForRole: (role: string) => phaseByRole.get(role),
  });
}
