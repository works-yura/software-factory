import {
  createCardActionConfigSchema,
  INTAKE_ROUTE_CARD_SOURCE,
  INTAKE_ROUTE_METADATA_KEY,
  INTAKE_ROUTE_ORIGIN_METADATA_KEY,
  intakeTargetProblem,
  IntakeTargetError,
  landingPhase,
  parseWith,
  renderIntakeTemplate,
} from '@factory/core';
import type {
  BoardRegistry,
  CreateCardActionConfig,
  IntakeActionKind,
  IntakeRouteCardOrigin,
  IntakeScope,
  IntakeTriggerRoute,
} from '@factory/core';
import type { WorkItemsStorage } from '@factory/store';

/** The `create-card` action of a trigger route: each fire files one card at the route's target. */
export const CREATE_CARD_ACTION_KIND = 'create-card';

/** The actor a trigger route's commits are made under; the route's id follows it. */
export const INTAKE_ROUTE_ACTOR = 'factory-intake-route';

export interface CreateCardActionOptions {
  workItems: Pick<WorkItemsStorage, 'commitRuleEvaluation'>;
  boards: { load(scope: IntakeScope): Promise<BoardRegistry> };
  configVersion: string;
  now?: () => Date;
}

function targetProblem(registry: BoardRegistry, target: IntakeTriggerRoute['target']): string | undefined {
  return intakeTargetProblem(registry, { target, on: ['work_item.created'] })?.message;
}

/**
 * Files the fire's card through the same rule commit a provider arrival uses, under an ingress
 * identity of its own (`intake-route:<routeId>:<fireKey>`): the commit is atomic per identity, so a
 * fire delivered twice — a retried workflow step, a second replica — files one card. The card is the
 * `intake-route` source `<routeId>:<fireKey>`, so it can be found again by the fire alone. It lands
 * where the route says (its target); the board's phase rules then take it like any new card.
 */
export function createCardAction(options: CreateCardActionOptions): IntakeActionKind<CreateCardActionConfig> {
  const now = options.now ?? (() => new Date());
  return {
    kind: CREATE_CARD_ACTION_KIND,
    label: { uk: 'Створити картку', en: 'Create a card' },
    parse: config => parseWith(createCardActionConfigSchema, config),
    describe: (config, locale) => (locale === 'uk' ? `Картка «${config.titleTemplate}»` : `Card "${config.titleTemplate}"`),
    problems: async (route, _config) => {
      const problem = targetProblem(await options.boards.load(route), route.target);
      return problem ? [problem] : [];
    },
    run: async ({ route, config, fired, timeZone }) => {
      const scope = { orgId: route.orgId, factoryProjectId: route.factoryProjectId };
      const registry = await options.boards.load(scope);
      const problem = targetProblem(registry, route.target);
      if (problem) throw new IntakeTargetError(problem);
      const board = registry.get(route.target.boardKey)!;
      const fireKey = fired.fireKey ?? `manual:${fired.firedAt.toISOString()}`;
      const template = {
        firedAt: fired.firedAt,
        routeName: route.name,
        ...(timeZone ? { timeZone } : {}),
        ...(fired.payload ? { payload: fired.payload } : {}),
      };
      const description = renderIntakeTemplate(config.description, template).trim();
      const origin: IntakeRouteCardOrigin = {
        id: route.id,
        name: route.name,
        triggerKind: fired.triggerKind,
        firedAt: fired.firedAt.toISOString(),
        fireKey,
      };
      const identity = `intake-route:${route.id}:${fireKey}`;
      const result = await options.workItems.commitRuleEvaluation({
        ...scope,
        workItemId: null,
        ingress: { identity, triggerType: `intake-route.${fired.triggerKind}` },
        configVersion: options.configVersion,
        expectedRevision: null,
        actor: { type: 'system', id: `${INTAKE_ROUTE_ACTOR}:${route.id}` },
        outcome: { status: 'accepted' },
        // The person who set the route up consented to its runs, as for a card they file themselves.
        consentedBy: route.createdBy,
        decisions: [
          {
            type: 'upsertLinkedWorkItem',
            idempotencyKey: `${identity}:card`,
            board: board.id,
            source: INTAKE_ROUTE_CARD_SOURCE,
            sourceKey: `${route.id}:${fireKey}`,
            title: renderIntakeTemplate(config.titleTemplate, template).slice(0, 500) || route.name,
            url: null,
            stage: landingPhase(board, route.target.phaseKey),
            metadata: {
              ...(description ? { description } : {}),
              ...(config.repository ? { repository: config.repository } : {}),
              [INTAKE_ROUTE_ORIGIN_METADATA_KEY]: { ...origin },
              // This route placed the card, as the dispatcher stamps any route that places one: no
              // other route reads it.
              [INTAKE_ROUTE_METADATA_KEY]: route.id,
            },
          },
        ],
        causalChain: [],
        now: now(),
      });
      if (result.status === 'missing' || result.status === 'stale') {
        throw new Error(`The card for this fire could not be filed (${result.status}).`);
      }
      // The dispatcher files the card right after the commit and writes its id back onto this fire
      // (`cardFiled` → `IntakeRouteFiresStorage.setFireCard`).
      return { workItemId: null, ...(result.status === 'replayed' ? { note: 'This fire had already filed its card.' } : {}) };
    },
  };
}
