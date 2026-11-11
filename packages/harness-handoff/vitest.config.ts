import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'harness-handoff',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
