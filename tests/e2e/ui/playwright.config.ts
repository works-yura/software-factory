import { defineConfig } from '@playwright/test';
import path from 'node:path';

const output = path.resolve(import.meta.dirname, '../test-results');

/**
 * Browser end-to-end tests against the real dev server with the fake
 * `claude` (see global-setup.ts). Run from the repo root: `corepack pnpm e2e:ui`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: path.join(output, 'artifacts'),
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1400, height: 900 },
  },
  reporter: [['line']],
});
