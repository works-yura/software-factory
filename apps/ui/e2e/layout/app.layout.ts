import { test } from '@playwright/test';

import { checkPage, expectNoHorizontalOverflow, screenshotPath } from './harness';
import {
  accountMenuHandlers,
  appHandlers,
  INVITATION_ID,
  JOIN_TOKEN,
  onboardingHandlers,
  organizationLinkHandlers,
  SESSION_ID,
  threadHandlers,
} from './fixtures/app';

// The pages outside settings: organization links, the sidebar's account menu (open, with the
// organization submenu), the board, card moves and onboarding.
test.describe('app layout', () => {
  test('join link', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, { url: `/join/${JOIN_TOKEN}`, name: 'join', handlers: organizationLinkHandlers() });
  });

  test('invitation', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, {
      url: `/invite/${INVITATION_ID}`,
      name: 'invite',
      handlers: organizationLinkHandlers(),
    });
  });

  test('account menu, open on the organization submenu', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, { url: '/factories/fp-1/work', name: 'work-board', handlers: accountMenuHandlers() });
    // On a phone and a tablet the sidebar is a drawer: open it first.
    const drawer = page.getByRole('button', { name: 'Open navigation menu' });
    if (await drawer.isVisible()) await drawer.click();
    await page.getByRole('button', { name: /^Account menu|^Меню акаунта/ }).click();
    await page.getByRole('menuitem', { name: /^Switch organization from/ }).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: screenshotPath(testInfo, 'account-menu') });
    await expectNoHorizontalOverflow(page);
  });

  test('run queue, open', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, { url: '/factories/fp-1/work', name: 'work-board-queue', handlers: appHandlers() });
    await page.getByRole('button', { name: /queued/i }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: screenshotPath(testInfo, 'run-queue') });
    await expectNoHorizontalOverflow(page);
  });

  test('chat thread: composer and status line', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, {
      url: `/factories/fp-1/user/threads/${SESSION_ID}`,
      name: 'thread-composer',
      handlers: threadHandlers(),
    });
    await page.locator('[data-slot="composer-actions"]').screenshot({ path: screenshotPath(testInfo, 'composer-footer') });
  });

  test('card moves', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, { url: '/factories/fp-1/work/moves', name: 'card-moves', handlers: appHandlers() });
  });

  test('onboarding', async ({ page }, testInfo) => {
    await checkPage(page, testInfo, { url: '/onboarding', name: 'onboarding', handlers: onboardingHandlers() });
  });
});
