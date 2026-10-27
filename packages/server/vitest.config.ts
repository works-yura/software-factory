import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Timing instrumentation patches sandbox methods in place, which
    // would replace vi.fn mocks if a developer's shell sets the flag.
    env: { FACTORY_TIMING: '' },
  },
});
