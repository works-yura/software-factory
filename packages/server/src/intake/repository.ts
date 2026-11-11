import type { IntakeTriggerRouteRepository } from '@factory/core';
import { storedTriggerRoute } from '@factory/store';
import type { IntakeRouteFiresStorage, StoredBoardsStorage } from '@factory/store';

/**
 * The trigger-route repository the engine runs on: the routes live with every other intake route
 * (`StoredBoardsStorage`), their fires in the route fire log.
 */
export function intakeTriggerRouteRepository(
  boards: Pick<StoredBoardsStorage, 'findIntakeRouteById' | 'listTriggerRoutes'>,
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
  };
}
