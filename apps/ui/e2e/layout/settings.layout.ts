import { test } from '@playwright/test';

import { checkPage } from './harness';
import { settingsHandlers } from './fixtures/settings';

// Every settings section, signed in as an organization owner, with long names, emails, link
// names and URLs in the data: nothing may push the page sideways at 375, 768 or 1280 px.
const SECTIONS = [
  'account',
  'organization',
  'team',
  'preferences',
  'factory',
  'analytics',
  'repositories',
  'environment',
  'intake',
  'integrations',
  'models',
  'memory',
  'behavior',
  'debug',
] as const;

test.describe('settings layout', () => {
  for (const section of SECTIONS) {
    test(section, async ({ page }, testInfo) => {
      await checkPage(page, testInfo, {
        url: `/factories/fp-1/settings/${section}`,
        name: `settings-${section}`,
        handlers: settingsHandlers(),
      });
    });
  }

  test('connections: GitHub detail with the gh CLI tokens', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, {
      url: '/factories/fp-1/settings/integrations?connection=github%3Aapp',
      name: 'settings-connections-github',
      handlers: settingsHandlers(),
    });
  });
});
