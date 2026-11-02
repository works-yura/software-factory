import { defineConfig } from 'vitest/config';

/**
 * Unit and MSW UI projects share this entrypoint so targeted test runs can
 * select the right environment from the changed test file path.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit:factory-ui',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // playground-ui's dist (packages/playground-ui, a workspace link) imports CSS; let Vite transform it.
          server: { deps: { inline: [/@mastra\/playground-ui/] } },
        },
      },
      './e2e/ui/vitest.config.ts',
    ],
  },
});
