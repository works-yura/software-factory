import type { FullConfig } from '@playwright/test';

import { ensureUiBuilt, startStack } from '../src/stack.ts';

/**
 * One dev server (fake `claude`) for every spec; workers read its URL and the
 * e2e person's session cookie from the environment. With FACTORY_E2E_BASE_URL already set (a stack you keep running
 * while iterating on specs), it is reused instead.
 */
export default async function globalSetup(_config: FullConfig) {
  if (process.env.FACTORY_E2E_BASE_URL) {
    if (!process.env.FACTORY_E2E_SESSION_COOKIE) {
      throw new Error('FACTORY_E2E_BASE_URL reuses a running server: set FACTORY_E2E_SESSION_COOKIE to its e2e session too.');
    }
    return;
  }
  ensureUiBuilt();
  const stack = await startStack({ label: 'ui', claude: 'fake' });
  process.env.FACTORY_E2E_BASE_URL = stack.baseUrl;
  process.env.FACTORY_E2E_SESSION_COOKIE = stack.sessionCookie;
  process.env.FACTORY_E2E_GITLAB_PROJECT_ID = String(stack.gitlab.project.id);
  process.env.FACTORY_E2E_GITLAB_PROJECT_PATH = stack.gitlab.project.path;
  return async () => {
    await stack.stop();
  };
}
