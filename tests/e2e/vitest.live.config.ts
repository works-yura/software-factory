import { defineConfig } from 'vitest/config';

// The live check (scripts/live-claude-check.sh): the server scenario with the
// REAL `claude` CLI. It spends the person's Claude subscription, so it is never
// part of `e2e` or `verify`, and its test skips unless FACTORY_E2E_LIVE=1.
export default defineConfig({
  test: {
    name: 'e2e:live',
    environment: 'node',
    include: ['live/**/*.e2e.test.ts'],
    testTimeout: 6 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
