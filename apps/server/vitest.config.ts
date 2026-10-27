import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit:mastracode-web',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          // Scenarios drive a real in-process controller server + AIMock; they
          // need network + node builtins, so run in the node environment.
          name: 'e2e:mastracode-web',
          environment: 'node',
          include: ['e2e/web/**/*.scenario.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Run test files sequentially — each scenario starts its own AIMock
          // + AgentController + Hono server, and concurrent runs can cause
          // port/state collisions in the shared process.
          fileParallelism: false,
          // eclipt: scenarios import factory-ui sources, which pull in
          // playground-ui's dist with bare `.css` imports Node cannot load.
          server: { deps: { inline: [/@mastra\/playground-ui/] } },
        },
      },
    ],
  },
});
