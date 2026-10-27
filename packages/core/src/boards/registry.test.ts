import { describe, expect, it } from 'vitest';
import { defineBoard } from './define-board.ts';
import { createBoardRegistry } from './registry.ts';
import { createTestBoard } from './test-utils.ts';

const customBoard = createTestBoard();

describe('createBoardRegistry', () => {
  it('installs only the pipelines the caller passes', () => {
    const registry = createBoardRegistry({ boards: [customBoard] });

    expect([...registry.keys()]).toEqual(['release']);
    expect(registry.get('release')).toBe(customBoard);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('supports an empty registry', () => {
    expect(createBoardRegistry().size).toBe(0);
    expect(createBoardRegistry().size).toBe(0);
  });

  it('rejects duplicate ids', () => {
    expect(() => createBoardRegistry({ boards: [customBoard, customBoard] })).toThrow("duplicate board id 'release'");
  });

  it('installs an explicit board even when its id used to be built in', () => {
    const replacement = defineBoard({
      id: 'work',
      title: 'Replacement',
      initialPhase: 'start',
      phases: { start: { title: 'Start', kind: 'resting' } },
    });

    const registry = createBoardRegistry({ boards: [replacement] });

    expect([...registry.keys()]).toEqual(['work']);
    expect(registry.get('work')).toBe(replacement);
  });
});
