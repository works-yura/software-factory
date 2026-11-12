import { INTAKE_ROUTE_CARD_SOURCE } from '@factory/core';
import type { IntakeTriggerRouteRepository } from '@factory/core';
import { storedTriggerRoute } from '@factory/store';
import type { IntakeRouteFiresStorage, StoredBoardsStorage } from '@factory/store';

/**
 * The trigger-route repository the engine runs on: the routes live with every other intake route
 * (`StoredBoardsStorage`), their fires in the route fire log; a route's fire lock is on the
 * project's route lock row (`factory_intake_route_locks`).
 */
export function intakeTriggerRouteRepository(
  boards: Pick<
    StoredBoardsStorage,
    'findIntakeRouteById' | 'listTriggerRoutes' | 'claimIntakeRouteFire' | 'releaseIntakeRouteFire'
  >,
  fires: Pick<IntakeRouteFiresStorage, 'recordFire' | 'findFire' | 'listFires' | 'lastDoneFire'>,
): IntakeTriggerRouteRepository {
  return {
    getTriggerRoute: async id => {
      const route = await boards.findIntakeRouteById(id);
      return route ? storedTriggerRoute(route) : null;
    },
    listTriggerRoutes: async () =>
      (await boards.listTriggerRoutes()).flatMap(route => {
        const trigger = storedTriggerRoute(route);
        return trigger ? [trigger] : [];
      }),
    recordFire: input => fires.recordFire(input),
    findFire: (routeId, fireKey) => fires.findFire(routeId, fireKey),
    listFires: (scope, routeId, options) => fires.listFires(scope, routeId, options),
    lastDoneFire: routeId => fires.lastDoneFire(routeId),
    claimFire: (route, holder, until) => boards.claimIntakeRouteFire(route, route.id, holder, until),
    releaseFire: (route, holder) => boards.releaseIntakeRouteFire(route, route.id, holder),
  };
}

/**
 * The dispatcher's `cardFiled` hook for route cards: a route's card is filed after its fire was
 * committed, so its id is written back onto the fire (`<routeId>:<fireKey>` is the card's source
 * key). A fire not recorded yet throws, so the decision retries once the engine has recorded it.
 */
export function writeFireCardBack(fires: Pick<IntakeRouteFiresStorage, 'setFireCard'>) {
  return async ({ source, sourceKey, workItemId }: { source: string; sourceKey: string; workItemId: string }) => {
    if (source !== INTAKE_ROUTE_CARD_SOURCE) return;
    const separator = sourceKey.indexOf(':');
    if (separator < 0) return;
    const recorded = await fires.setFireCard(sourceKey.slice(0, separator), sourceKey.slice(separator + 1), workItemId);
    if (!recorded) throw new Error(`The fire behind card ${workItemId} isn't recorded yet; retrying.`);
  };
}
