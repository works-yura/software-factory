import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'device:node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/react/**', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'device:dom',
          environment: 'jsdom',
          include: ['src/react/**/*.test.ts', 'src/react/**/*.test.tsx'],
        },
      },
    ],
  },
});
