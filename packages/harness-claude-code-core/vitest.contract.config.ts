import { defineConfig } from 'vitest/config';

// The CLI contract: the real `claude` CLI against a scripted model
// (contract/mock-anthropic.ts). No subscription is spent; it checks what the
// unit tests cannot, that the CLI does what our flags and rules mean.
export default defineConfig({
  test: {
    name: 'claude-cli-contract',
    environment: 'node',
    include: ['contract/**/*.contract.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
