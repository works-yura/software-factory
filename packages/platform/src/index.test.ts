import { describe, expect, it } from 'vitest';

import { MastraFactory } from './index.ts';

describe('@mastra/factory package root', () => {
  it('exports the MastraFactory entry point', () => {
    expect(typeof MastraFactory).toBe('function');
  });
});
