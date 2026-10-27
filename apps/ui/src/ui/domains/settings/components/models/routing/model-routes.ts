import { Building2, MessagesSquare, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { lazyLabels } from '../../../../../i18n/lazy';

export type ModelLane = 'chats' | 'runs';
/** One model scope: chats and work-item runs both run on the Factory defaults. */
export type ModelDefaults = 'factory';

export const MODEL_LANES: readonly ModelLane[] = ['chats', 'runs'];

export const MODEL_ROUTES: Record<ModelLane, ModelDefaults> = { chats: 'factory', runs: 'factory' };

export const MODEL_DEFAULTS_LABELS: Readonly<Record<ModelDefaults, string>> = lazyLabels(
  ['factory'] as const,
  () => 'settings:models.factoryDefaults.title',
);

export const MODEL_DEFAULTS_ICONS: Record<ModelDefaults, LucideIcon> = {
  factory: Building2,
};

export const MODEL_DEFAULTS_TONES: Record<ModelDefaults, string> = {
  factory: 'text-chart-blue',
};

export const MODEL_LANE_LABELS: Readonly<Record<ModelLane, string>> = lazyLabels(
  MODEL_LANES,
  lane => `settings:routing.lanes.${lane}`,
);

export const MODEL_LANE_ICONS: Record<ModelLane, LucideIcon> = {
  chats: MessagesSquare,
  runs: SquareKanban,
};

export function connectorPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const midX = (fromX + toX) / 2;
  return `M${fromX} ${fromY} C${midX} ${fromY} ${midX} ${toY} ${toX} ${toY}`;
}
