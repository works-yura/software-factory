/**
 * What a card filed by a trigger route carries about where it came from: the route and the fire.
 * Kept on the card's metadata for its history and the settings; routing reads none of it, since a
 * trigger route places its own cards.
 */

/** Card metadata key holding the {@link IntakeRouteCardOrigin}. */
export const INTAKE_ROUTE_ORIGIN_METADATA_KEY = 'intakeRouteOrigin';

/** The work-item source a trigger route's card is filed under; its key is `<routeId>:<fireKey>`. */
export const INTAKE_ROUTE_CARD_SOURCE = 'intake-route';

export interface IntakeRouteCardOrigin {
  /** The route's id. */
  id: string;
  /** The route's name when it fired. */
  name: string;
  triggerKind: string;
  /** ISO time of the fire. */
  firedAt: string;
  fireKey: string;
}

export function intakeRouteOrigin(
  metadata: Record<string, unknown> | null | undefined,
): IntakeRouteCardOrigin | undefined {
  const value = metadata?.[INTAKE_ROUTE_ORIGIN_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const origin = value as Record<string, unknown>;
  if (typeof origin.id !== 'string' || typeof origin.name !== 'string') return undefined;
  return {
    id: origin.id,
    name: origin.name,
    triggerKind: typeof origin.triggerKind === 'string' ? origin.triggerKind : 'schedule',
    firedAt: typeof origin.firedAt === 'string' ? origin.firedAt : '',
    fireKey: typeof origin.fireKey === 'string' ? origin.fireKey : '',
  };
}
