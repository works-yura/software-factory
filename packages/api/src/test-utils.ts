/**
 * Test-only helpers for the route modules in this package.
 */

import type { Card } from '@factory/store';

const CARD_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/** A card as storage holds it, on the Work board's first phase; `overrides` replace whole fields. */
export function testCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    orgId: 'org1',
    createdBy: 'u1',
    factoryProjectId: '00000000-0000-4000-8000-0000000000aa',
    workItemId: `work-${id}`,
    parentWorkItemId: null,
    parentBoardItemId: null,
    board: 'work',
    triageType: null,
    acceptedAt: null,
    autonomyArmedAt: null,
    description: null,
    commentCount: 0,
    revision: 1,
    workItem: {
      id: `work-${id}`,
      orgId: 'org1',
      factoryProjectId: '00000000-0000-4000-8000-0000000000aa',
      sources: [],
      provider: 'factory',
      externalId: id,
      key: null,
      url: null,
      title: `Card ${id}`,
      state: null,
      labels: [],
      author: null,
      parentWorkItemId: null,
      metadata: null,
      revision: 1,
      syncedAt: null,
      createdAt: CARD_CREATED_AT,
      updatedAt: CARD_CREATED_AT,
    },
    externalSource: null,
    title: `Card ${id}`,
    stages: ['intake'],
    stageHistory: [],
    sessions: {},
    metadata: {},
    createdAt: CARD_CREATED_AT,
    updatedAt: CARD_CREATED_AT,
    ...overrides,
  };
}
