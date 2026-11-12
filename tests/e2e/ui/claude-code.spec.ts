import { expect, test, type Page } from '@playwright/test';

import { api, createChat, createClaudeFactory } from '../src/factory-api.ts';

const baseUrl = () => {
  const url = process.env.FACTORY_E2E_BASE_URL;
  if (!url) throw new Error('FACTORY_E2E_BASE_URL is unset: run through ui/playwright.config.ts (its global setup starts the server).');
  return url;
};
const projectId = () => Number(process.env.FACTORY_E2E_GITLAB_PROJECT_ID);
const projectPath = () => process.env.FACTORY_E2E_GITLAB_PROJECT_PATH ?? 'e2e/fixture';

interface FactoryRow {
  id: string;
  name: string;
  harness?: string;
  harnessModelDefaults?: Record<string, { model: string }>;
}

async function factories(): Promise<FactoryRow[]> {
  return (await api<{ projects: FactoryRow[] }>(baseUrl(), '/web/factory/projects')).projects;
}

/** Fails the test on any uncaught page error, which a broken bundle shows first. */
function watchPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

/** The wizard's step title (the palette input's label; a decorative copy is aria-hidden). */
const stepTitle = (page: Page, title: string) => page.locator('label[cmdk-label]', { hasText: title });

let anchor: { factoryId: string; projectRepositoryId: string };

// The e2e person is signed in (Google sign-in; the session was written by the stack).
test.beforeEach(async ({ context }) => {
  const cookie = process.env.FACTORY_E2E_SESSION_COOKIE;
  if (!cookie) throw new Error('FACTORY_E2E_SESSION_COOKIE is unset: run through ui/playwright.config.ts.');
  const separator = cookie.indexOf('=');
  await context.addCookies([
    { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl(), httpOnly: true, sameSite: 'Lax' },
  ]);
});

test.beforeAll(async () => {
  // A Factory to start from: with none, the app shows first-Factory onboarding instead of the wizard.
  anchor = await createClaudeFactory(baseUrl(), { name: 'UI anchor', projectId: projectId() });
});

test('New Factory wizard: the Claude Code harness offers Claude models, not Mastra providers', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto(`${baseUrl()}/factories/${anchor.factoryId}/new-factory`);

  await expect(stepTitle(page, 'Name your new Factory')).toBeVisible();
  await page.keyboard.type('Wizard Claude Factory');
  await page.getByRole('option', { name: /Create “Wizard Claude Factory”/ }).click();

  await expect(stepTitle(page, 'Choose how your agents run')).toBeVisible();
  await expect(page.getByRole('option', { name: /Mastra/ })).toBeVisible();
  await page.getByRole('option', { name: /Claude Code/ }).click();

  await expect(stepTitle(page, 'Choose your codebase')).toBeVisible();
  // Repositories are picked several at a time now: select the one, then continue with it.
  await page.getByRole('option', { name: new RegExp(projectPath()) }).click();
  await page.getByRole('option', { name: /^Continue with 1 repository/ }).click();

  // The model step for a Claude Code Factory: sign-in status and Claude models only.
  await expect(stepTitle(page, 'Choose your Claude model')).toBeVisible();
  await expect(stepTitle(page, 'Choose your Factory model')).toHaveCount(0);
  for (const model of ['Claude Code default', 'Opus', 'Sonnet', 'Haiku']) {
    await expect(page.getByRole('option', { name: new RegExp(`^${model}`) })).toBeVisible();
  }
  // Turns run only on the organization's Claude sign-ins (the stack wrote one for the e2e person).
  await expect(page.getByText('Runs on your organization’s Claude Code account.', { exact: false })).toBeVisible();
  // Mastra's provider step would offer provider sign-in and API keys.
  for (const mastraOnly of ['Connect with an API key', 'Search models and providers…', 'API key providers']) {
    await expect(page.getByText(mastraOnly)).toHaveCount(0);
  }
  await expect(page.getByPlaceholder('Search models and providers…')).toHaveCount(0);

  await page.getByRole('option', { name: /^Haiku/ }).click();
  await expect.poll(async () => (await factories()).find(f => f.name === 'Wizard Claude Factory')).toMatchObject({
    harness: 'claude-code',
    harnessModelDefaults: { 'claude-code': { model: 'haiku' } },
  });
  expect(errors).toEqual([]);
});

test('Settings → Models: the harness switch persists', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { factoryId } = await createClaudeFactory(baseUrl(), { name: 'Harness switch', projectId: projectId() });
  await page.goto(`${baseUrl()}/factories/${factoryId}/settings/models`);

  const control = page.getByRole('radiogroup', { name: 'Agents run on' });
  await expect(control).toBeVisible();
  await expect(control.getByRole('radio', { name: 'Claude Code' })).toBeChecked();

  await control.getByRole('radio', { name: 'Mastra' }).click();
  await expect.poll(async () => (await factories()).find(f => f.id === factoryId)?.harness).toBe('mastra');
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Agents run on' }).getByRole('radio', { name: 'Mastra' })).toBeChecked();

  await page.getByRole('radiogroup', { name: 'Agents run on' }).getByRole('radio', { name: 'Claude Code' }).click();
  await expect.poll(async () => (await factories()).find(f => f.id === factoryId)?.harness).toBe('claude-code');
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Agents run on' }).getByRole('radio', { name: 'Claude Code' })).toBeChecked();
  expect(errors).toEqual([]);
});

test('Chat: a Write waiting for permission shows the approval card, and Approve continues the run', async ({ page }) => {
  const errors = watchPageErrors(page);
  const chat = await createChat(baseUrl(), anchor.projectRepositoryId, 'Write the proof file');
  await page.goto(`${baseUrl()}/factories/${anchor.factoryId}/user/threads/${chat.sessionId}`);
  // Sent from the composer, as a person would.
  const composer = page.getByRole('region', { name: 'Thread composer' });
  await expect(composer.getByRole('button', { name: /^Session model/ })).toContainText('Haiku');
  await composer.getByRole('textbox', { name: 'Message' }).fill('List the work items, then write e2e-proof.txt.');
  await composer.getByRole('button', { name: 'Send message' }).click();

  // The tool approval card: "Approval required" on the Write, with Approve / Decline.
  const card = page.getByRole('group', { name: 'Tool approval for Write' });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.getByRole('status')).toHaveText('Approval required');
  const allow = card.getByRole('button', { name: 'Approve Write' });
  await expect(allow).toBeVisible();
  await expect(card.getByRole('button', { name: 'Decline Write' })).toBeVisible();
  await allow.click();

  await expect(page.getByText('Wrote e2e-proof.txt after the person allowed it.')).toBeVisible({ timeout: 90_000 });
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
