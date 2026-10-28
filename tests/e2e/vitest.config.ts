import { defineConfig } from 'vitest/config';

// Server end-to-end tests: each file boots the real dev server (minutes), so
// they are their own run (`corepack pnpm e2e` at the root), not part of the
// unit suites.
export default defineConfig({
  test: {
    name: 'e2e:server',
    environment: 'node',
    include: ['server/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 10 * 60_000,
    // One dev server per checkout at a time (it writes apps/server/.mastra/output).
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
