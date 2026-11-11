import { defineBoard } from './define-board.ts';
import type { BoardPhaseRunner } from './define-board.ts';

export function createTestBoard(options: { id?: string; shippingRunner?: Omit<BoardPhaseRunner, 'context'> } = {}) {
  return defineBoard({
    id: options.id ?? 'release',
    title: 'Release',
    initialPhase: 'queued',
    phases: {
      queued: { title: 'Queued', kind: 'resting', nextPhases: ['shipping', 'shipped'] },
      shipping: {
        title: 'Shipping',
        kind: 'working',
        runner: { ...options.shippingRunner, context: 'release' },
        next: 'shipped',
      },
      shipped: { title: 'Shipped', kind: 'terminal' },
    },
  });
}
