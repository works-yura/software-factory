import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_HARNESS, MASTRA_HARNESS } from '@factory/contracts';

import { unsupportedCommands } from '../useChatCommandRegistry';

describe('unsupportedCommands', () => {
  it('keeps every command on Mastra, and on a harness still loading', () => {
    expect([...unsupportedCommands(MASTRA_HARNESS)]).toEqual([]);
    expect([...unsupportedCommands(undefined)]).toEqual([]);
  });

  it('leaves out what Claude Code has no counterpart for, instead of failing when used', () => {
    expect([...unsupportedCommands(CLAUDE_CODE_HARNESS)].sort()).toEqual(
      ['goal', 'goal-clear', 'goal-pause', 'goal-resume', 'model', 'om', 'permissions', 'think', 'yolo'].sort(),
    );
  });

  it('reads capabilities, not ids: a new harness gets its own set', () => {
    const harness = { ...MASTRA_HARNESS, id: 'other', supports: { ...MASTRA_HARNESS.supports, goal: false } };
    expect([...unsupportedCommands(harness)].sort()).toEqual(['goal', 'goal-clear', 'goal-pause', 'goal-resume']);
  });
});
