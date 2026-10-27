import type { FactoryRuleHandler, FactoryStageRuleContext } from '../rules/types.ts';
import { defineBoard } from './define-board.ts';

export function createTestBoard(
  options: { id?: string; onShipped?: FactoryRuleHandler<FactoryStageRuleContext> } = {},
) {
  return defineBoard({
    id: options.id ?? 'release',
    title: 'Release',
    initialPhase: 'queued',
    phases: {
      queued: { title: 'Queued', kind: 'resting', outcomes: { ship: 'shipping', skip: 'shipped' } },
      shipping: { title: 'Shipping', kind: 'working', role: 'release', next: 'shipped' },
      shipped: {
        title: 'Shipped',
        kind: 'terminal',
        onEnter: options.onShipped ? { issue: options.onShipped } : undefined,
      },
    },
  });
}
