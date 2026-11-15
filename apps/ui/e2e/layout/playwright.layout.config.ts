import { defineConfig } from '@playwright/test';
import path from 'node:path';

/**
 * Layout harness: every page at a phone, a tablet and a desktop width, in a real browser, with the
 * API answered by MSW handlers (no server). Each test screenshots its page and fails when anything
 * pushes the page sideways. Separate from the knowledge-proof config (`../playwright.config.ts`).
 *
 *   pnpm --filter ./apps/ui test:layout
 *   LAYOUT_OUTPUT=/some/dir pnpm --filter ./apps/ui test:layout   # where screenshots go
 */
const output = process.env.LAYOUT_OUTPUT ? path.resolve(process.env.LAYOUT_OUTPUT) : path.resolve('test-results/layout');
const port = Number(process.env.LAYOUT_PORT ?? 4179);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.layout.ts',
  outputDir: path.join(output, 'artifacts'),
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
  },
  metadata: { screenshots: output },
  projects: [
    { name: 'phone', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
