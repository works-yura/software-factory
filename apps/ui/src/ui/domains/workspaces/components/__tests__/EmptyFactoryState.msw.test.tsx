import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Routes, Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { GithubRepo, FactoryProjectPayload } from '../../services/github';
import type { GitLabProject } from '../../../factory/services/gitlab';
import {
  ONBOARDING_FACTORY_KEY,
  ONBOARDING_DRAFT_KEY,
  ONBOARDING_STEP_KEY,
  persistOnboardingDraft,
  readOnboardingDraft,
} from '../../services/onboardingFlow';
import { EmptyFactoryState } from '../EmptyFactoryState';

const repo: GithubRepo = {
  id: 99,
  fullName: 'octo/hello',
  name: 'hello',
  owner: 'octo',
  defaultBranch: 'main',
  private: false,
  installationId: 7,
  installationStorageId: 'inst-7',
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/hello',
};
const otherRepo: GithubRepo = { ...repo, id: 100, fullName: 'octo/other', name: 'other', defaultBranch: 'develop' };
const thirdRepo: GithubRepo = { ...repo, id: 101, fullName: 'octo/third', name: 'third' };
const gitlabProject: GitLabProject = {
  id: 'gitlab-source',
  name: 'backend',
  projectId: '42',
  projectPath: 'team/backend',
  installationStorageId: 'gitlab-inst',
  defaultBranch: 'develop',
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/backend',
};
const model = { providerId: 'openai', modelId: 'openai/gpt-5.6-sol', method: 'api_key' as const };

function renderOnboarding() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<EmptyFactoryState />} />
        <Route path="/factories/:id" element={<h1>Factory ready</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

function registerSetup(failure?: 'connection' | 'intake' | 'model') {
  const writes: { path: string; body: unknown }[] = [];
  let project: FactoryProjectPayload | undefined;
  let failed = false;
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({ enabled: true, connected: true, reason: 'ready', installations: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo, otherRepo] })),
    http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
      HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
    ),
    http.get(`${TEST_BASE_URL}/web/gitlab/projects`, () => HttpResponse.json({ projects: [gitlabProject] })),
    http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
      HttpResponse.json({
        orgKeyAdmin: true,
        providers: [
          { provider: 'openai', source: 'stored-org', orgCredential: 'api_key', userCredential: 'api_key' },
          { provider: 'anthropic', source: 'stored-org', orgCredential: 'api_key', userCredential: 'api_key' },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({
        models: [
          { id: model.modelId, provider: 'openai', modelName: 'gpt-5.6-sol', hasApiKey: true },
          { id: 'anthropic/claude-fable-5', provider: 'anthropic', modelName: 'claude-fable-5', hasApiKey: true },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: project ? [project] : [] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
      project ? HttpResponse.json({ project }) : HttpResponse.json({ error: 'not_found' }, { status: 404 }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
      HttpResponse.json({ connections: [] }),
    ),
    http.post(`${TEST_BASE_URL}/web/factory/projects`, async ({ request }) => {
      const body = await request.json();
      writes.push({ path: 'create', body });
      project = { id: 'fp-1', name: 'hello' };
      return HttpResponse.json({ project });
    }),
    http.post(`${TEST_BASE_URL}/web/gitlab/projects/registration`, async ({ request }) => {
      writes.push({ path: 'registration', body: await request.json() });
      return HttpResponse.json({ project: gitlabProject });
    }),
    http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, async ({ request }) => {
      writes.push({ path: 'connection', body: await request.json() });
      if (failure === 'connection' && !failed) {
        failed = true;
        return HttpResponse.json({ error: 'unavailable' }, { status: 502 });
      }
      return HttpResponse.json({ connection: { id: 'conn-1' } });
    }),
    http.post(
      `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
      async ({ request }) => {
        writes.push({ path: 'repository', body: await request.json() });
        return HttpResponse.json({
          projectRepository: {
            id: 'link-1',
            branch: 'main',
            sandboxWorkdir: '/workspace/hello',
            repository: { slug: 'octo/hello', externalId: '99', defaultBranch: 'main' },
          },
        });
      },
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () => HttpResponse.json({ config: {} })),
    http.put(`${TEST_BASE_URL}/web/intake/config`, async ({ request }) => {
      const body = await request.json();
      writes.push({ path: 'intake', body });
      if (failure === 'intake' && !failed) {
        failed = true;
        return HttpResponse.json({ error: 'unavailable' }, { status: 502 });
      }
      return HttpResponse.json({ config: body });
    }),
    http.patch(`${TEST_BASE_URL}/web/factory/projects/fp-1`, async ({ request }) => {
      writes.push({ path: 'model', body: await request.json() });
      if (failure === 'model' && !failed) {
        failed = true;
        return HttpResponse.json({ error: 'unavailable' }, { status: 502 });
      }
      return HttpResponse.json({ project });
    }),
    http.post(`${TEST_BASE_URL}/web/config/om/provider-defaults`, async ({ request }) => {
      writes.push({ path: 'om', body: await request.json() });
      return HttpResponse.json({ error: 'Removed endpoint' }, { status: 404 });
    }),
  );
  return writes;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe('Draft Factory onboarding', () => {
  it('lets users change repository, VCS and model, then commits only the reviewed choices', async () => {
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'vcs');
    const writes = registerSetup();
    const user = userEvent.setup();
    renderOnboarding();
    await user.hover(await screen.findByRole('radio', { name: 'octo/hello' }));
    expect(within(screen.getByLabelText('Codebase preview')).getByText('octo/hello')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'octo/hello' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Go back to previous step' }));
    expect(await screen.findByRole('radio', { name: 'octo/hello' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'octo/other' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'OpenAI' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Ready to create.' })).toBeInTheDocument();
    expect(writes).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit codebase' }));
    expect(await screen.findByRole('radio', { name: 'octo/other' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Change provider' }));
    await user.click(screen.getByRole('button', { name: 'Continue with GitLab' }));
    await user.click(await screen.findByRole('radio', { name: 'team/backend' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const review = within(await screen.findByRole('region', { name: 'Review factory setup' }));
    expect(review.getByText('team/backend')).toBeInTheDocument();
    expect(review.getByText('GitLab · develop')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit model' }));
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
    await user.click(screen.getByRole('button', { name: 'Change provider' }));
    await user.click(await screen.findByRole('button', { name: 'Anthropic' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(writes).toEqual([]);
    expect(readOnboardingDraft().model?.providerId).toBe('anthropic');
    await user.click(screen.getByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
    expect(writes.filter(item => item.path === 'create')).toEqual([
      { path: 'create', body: { name: 'backend' } },
    ]);
    expect(writes.find(item => item.path === 'registration')?.body).toEqual({ sourceId: 'gitlab-source' });
    expect(writes.find(item => item.path === 'connection')?.body).toEqual({
      installationId: 'gitlab-inst',
      integrationId: 'gitlab',
    });
    expect(writes.find(item => item.path === 'repository')?.body).toMatchObject({
      repository: { externalId: '42', slug: 'team/backend' },
      branch: 'develop',
    });
    expect(writes.find(item => item.path === 'model')?.body).toEqual({ defaultModelId: 'anthropic/claude-fable-5' });
    expect(readOnboardingDraft()).toEqual({});
    expect(sessionStorage.getItem(ONBOARDING_FACTORY_KEY)).toBeNull();
  }, 20_000);

  it('restores repository and model choices after a redirect or reload without writing them', async () => {
    const writes = registerSetup();
    persistOnboardingDraft({ repository: otherRepo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'model-provider');
    const view = renderOnboarding();
    expect(await screen.findByRole('combobox')).toHaveValue('GPT-5.6 Sol');
    view.unmount();
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'vcs');
    renderOnboarding();
    expect(await screen.findByRole('radio', { name: 'octo/other' })).toBeChecked();
    expect(writes).toEqual([]);
  });

  it('returns directly to review after reloading an edited step', async () => {
    const writes = registerSetup();
    persistOnboardingDraft({ repository: repo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    const view = renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Edit codebase' }));
    view.unmount();
    renderOnboarding();
    await user.click(await screen.findByRole('radio', { name: 'octo/other' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Ready to create.' })).toBeInTheDocument();
    expect(readOnboardingDraft().repository?.fullName).toBe('octo/other');
    expect(writes).toEqual([]);
  });

  it.each(['connection', 'model'] as const)(
    'reuses the pending Factory after a failed final %s save and reload',
    async failure => {
      const writes = registerSetup(failure);
      persistOnboardingDraft({ repository: repo, model });
      sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
      const user = userEvent.setup();
      const view = renderOnboarding();
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('502');
      expect(sessionStorage.getItem(ONBOARDING_FACTORY_KEY)).toBe('fp-1');
      view.unmount();
      renderOnboarding();
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
      await waitFor(() => expect(writes.filter(item => item.path === 'create')).toHaveLength(1));
    },
  );

  it('creates a new Factory when the pending one is no longer accessible', async () => {
    const writes = registerSetup();
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-gone`, () =>
        HttpResponse.json({ error: 'forbidden' }, { status: 403 }),
      ),
    );
    persistOnboardingDraft({ repository: repo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    sessionStorage.setItem(ONBOARDING_FACTORY_KEY, 'fp-gone');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
    expect(writes.filter(item => item.path === 'create')).toHaveLength(1);
  });

  it.each(['intake', 'model'] as const)(
    'replaces only its own repository link when the codebase changes after a failed %s save',
    async failure => {
      const writes = registerSetup(failure);
      const links: { id: string; repository: { slug: string; externalId: string; defaultBranch: string } }[] = [];
      server.use(
        http.post(
          `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
          async ({ request }) => {
            const body = (await request.json()) as { repository: { slug: string; externalId: string } };
            const link = {
              id: `link-${body.repository.externalId}`,
              repository: { ...body.repository, defaultBranch: 'main' },
            };
            if (!links.some(existing => existing.id === link.id)) links.push(link);
            return HttpResponse.json({ projectRepository: { ...link, branch: 'main', sandboxWorkdir: '/workspace' } });
          },
        ),
        http.delete(`${TEST_BASE_URL}/web/factory/projects/fp-1/repositories/:linkId`, ({ params }) => {
          writes.push({ path: 'unlink', body: params.linkId });
          links.splice(
            links.findIndex(link => link.id === params.linkId),
            1,
          );
          return HttpResponse.json({ ok: true });
        }),
      );
      persistOnboardingDraft({ repository: repo, model });
      sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
      const user = userEvent.setup();
      renderOnboarding();
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      links.push({
        id: 'link-teammate',
        repository: { slug: 'octo/teammate', externalId: '7', defaultBranch: 'main' },
      });
      await user.click(screen.getByRole('button', { name: 'Edit codebase' }));
      await user.click(await screen.findByRole('radio', { name: 'octo/other' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));

      expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
      expect(writes.filter(item => item.path === 'create')).toHaveLength(1);
      expect(writes.filter(item => item.path === 'unlink')).toEqual([{ path: 'unlink', body: 'link-99' }]);
      expect(writes.filter(item => item.path === 'model').map(item => item.body)).toContainEqual({ name: 'other' });
      expect(links.map(link => link.repository.slug)).toEqual(['octo/teammate', 'octo/other']);
    },
  );

  it.each([thirdRepo, repo])(
    'removes superseded links after a failed cleanup, reload, and change to $fullName',
    async finalRepo => {
      const writes = registerSetup('model');
      const repositories = [repo, otherRepo, thirdRepo];
      const teammateRepo: GithubRepo = { ...repo, id: 7, name: 'teammate', fullName: 'octo/teammate' };
      const links = new Map<string, GithubRepo>([['link-teammate', teammateRepo]]);
      let cleanupFailed = false;
      server.use(
        http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: repositories })),
        http.post(
          `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
          async ({ request }) => {
            const body = z.object({ repository: z.object({ externalId: z.string() }) }).parse(await request.json());
            const selected = repositories.find(item => String(item.id) === body.repository.externalId);
            if (!selected) return HttpResponse.json({ error: 'not_found' }, { status: 404 });
            const id = `link-${selected.id}`;
            links.set(id, selected);
            return HttpResponse.json({
              projectRepository: {
                id,
                branch: selected.defaultBranch,
                sandboxWorkdir: selected.sandboxWorkdir,
                repository: {
                  slug: selected.fullName,
                  externalId: String(selected.id),
                  defaultBranch: selected.defaultBranch,
                },
              },
            });
          },
        ),
        http.delete(`${TEST_BASE_URL}/web/factory/projects/fp-1/repositories/:linkId`, ({ params }) => {
          writes.push({ path: 'unlink', body: params.linkId });
          if (!cleanupFailed) {
            cleanupFailed = true;
            return HttpResponse.json({ error: 'unavailable' }, { status: 502 });
          }
          links.delete(String(params.linkId));
          return HttpResponse.json({ ok: true });
        }),
      );
      persistOnboardingDraft({ repository: repo, model });
      sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
      const user = userEvent.setup();
      const view = renderOnboarding();
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('502');

      await user.click(screen.getByRole('button', { name: 'Edit codebase' }));
      await user.click(await screen.findByRole('radio', { name: otherRepo.fullName }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to unlink repository (502)');
      expect([...links.keys()]).toEqual(['link-teammate', 'link-99', 'link-100']);

      view.unmount();
      renderOnboarding();
      await user.click(await screen.findByRole('button', { name: 'Edit codebase' }));
      await user.click(await screen.findByRole('radio', { name: finalRepo.fullName }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(await screen.findByRole('button', { name: 'Create factory' }));
      expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
      expect(writes.filter(item => item.path === 'create')).toHaveLength(1);
      expect([...links.values()].map(item => item.fullName)).toEqual(['octo/teammate', finalRepo.fullName]);
    },
  );

  it('refuses to create a Factory whose model is no longer available', async () => {
    const writes = registerSetup();
    persistOnboardingDraft({
      repository: repo,
      model: { ...model, modelId: 'openai/retired-model' },
    });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('openai/retired-model is no longer available');
    expect(writes).toEqual([]);
  });
});

describe('Members without company access', () => {
  function registerMemberWithoutCompanyAccount() {
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
        HttpResponse.json({
          orgKeyAdmin: false,
          providers: [{ provider: 'anthropic', source: 'none' }],
        }),
      ),
    );
  }

  it('asks members to have an admin connect the company account when shared access is gone while editing review', async () => {
    const writes = registerSetup();
    registerMemberWithoutCompanyAccount();
    persistOnboardingDraft({ repository: repo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Edit model' }));
    expect(await screen.findByText('An admin needs to connect the company account first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create factory' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('accepts legacy drafts that chose a setup and creates the Factory on the company account', async () => {
    const writes = registerSetup();
    sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ repository: repo, modelScope: 'hybrid', model, personal: model }),
    );
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    renderOnboarding();
    expect(await screen.findByRole('heading', { name: 'Ready to create.' })).toBeInTheDocument();
    expect(readOnboardingDraft()).toEqual({ repository: repo, model });
    await user.click(screen.getByRole('button', { name: 'Create factory' }));
    await screen.findByRole('heading', { name: 'Factory ready' });
    expect(writes.find(item => item.path === 'create')?.body).toEqual({ name: repo.name });
    expect(writes.find(item => item.path === 'model')?.body).toEqual({ defaultModelId: model.modelId });
  });
});

describe('Account presets', () => {
  it('connects the company account with an organization key and saves the Factory model', async () => {
    const writes = registerSetup();
    const credentials: Record<string, { orgCredential?: 'api_key' }> = { openai: {}, anthropic: {} };
    const savedKeys: { provider: string; scope: string }[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
        HttpResponse.json({
          orgKeyAdmin: true,
          providers: Object.entries(credentials).map(([provider, credential]) => ({
            provider,
            envVar: `${provider.toUpperCase()}_API_KEY`,
            source: credential.orgCredential ? 'stored-org' : 'none',
            ...credential,
          })),
        }),
      ),
      http.put(`${TEST_BASE_URL}/web/config/providers/:provider/key`, async ({ params, request }) => {
        const provider = z.enum(['openai', 'anthropic']).parse(params.provider);
        const body = z.object({ scope: z.literal('org') }).parse(await request.json());
        savedKeys.push({ provider, scope: body.scope });
        credentials[provider] = { orgCredential: 'api_key' };
        return HttpResponse.json({ ok: true });
      }),
    );
    persistOnboardingDraft({ repository: repo });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'model-provider');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'OpenAI' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('API key for OpenAI'), 'test-key');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await screen.findByRole('combobox');
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('region', { name: 'Review factory setup' });
    expect(savedKeys).toEqual([{ provider: 'openai', scope: 'org' }]);
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Create factory' }));
    await screen.findByRole('heading', { name: 'Factory ready' });
    expect(writes.find(item => item.path === 'create')?.body).toEqual({ name: repo.name });
    expect(writes.find(item => item.path === 'model')?.body).toEqual({ defaultModelId: model.modelId });
  });

  it('creates a Factory whose company account was connected through provider sign-in', async () => {
    const writes = registerSetup();
    let signedIn = false;
    const signInStarts: unknown[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
        HttpResponse.json({
          orgKeyAdmin: true,
          providers: [
            {
              provider: 'anthropic',
              envVar: 'ANTHROPIC_API_KEY',
              oauth: { supported: true, modes: ['paste-code'] },
              ...(signedIn ? { source: 'oauth-org', orgCredential: 'oauth' } : { source: 'none' }),
            },
          ],
        }),
      ),
      http.post(`${TEST_BASE_URL}/web/config/providers/anthropic/oauth/start`, async ({ request }) => {
        signInStarts.push(await request.json());
        return HttpResponse.json({
          sessionId: 'sign-in-1',
          kind: 'paste-code',
          url: 'https://example.com/authorize',
          instructions: 'Paste code',
          expiresAt: Date.now() + 600_000,
        });
      }),
      http.post(`${TEST_BASE_URL}/web/config/providers/anthropic/oauth/complete`, () => {
        signedIn = true;
        return HttpResponse.json({ status: 'complete' });
      }),
    );
    persistOnboardingDraft({ repository: repo });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'model-provider');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('tab', { name: 'Provider sign-in' }));
    await user.click(screen.getByRole('button', { name: 'Continue with Anthropic' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Authorization code'), 'demo-code');
    await user.click(dialog.getByRole('button', { name: 'Complete sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(signInStarts).toEqual([{ mode: 'paste-code', scope: 'org' }]);
    expect(readOnboardingDraft().model).toEqual({
      providerId: 'anthropic',
      method: 'oauth',
      modelId: 'anthropic/claude-fable-5',
    });
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    await screen.findByRole('heading', { name: 'Factory ready' });
    expect(writes.find(item => item.path === 'create')?.body).toEqual({ name: repo.name });
  });

  it('revalidates the company account catalog before creating the Factory', async () => {
    const writes = registerSetup();
    server.use(http.get(`${TEST_BASE_URL}/web/config/models`, () => HttpResponse.json({ models: [] })));
    persistOnboardingDraft({ repository: repo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available for the company account');
    expect(writes).toEqual([]);
  });

  it('asks users to review a connection whose sign-in method changed before confirmation', async () => {
    const writes = registerSetup();
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
        HttpResponse.json({ providers: [{ provider: 'openai', source: 'oauth-org', orgCredential: 'oauth' }] }),
      ),
    );
    persistOnboardingDraft({ repository: repo, model });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('connection for the company account has changed');
    expect(writes).toEqual([]);
  });

  it('creates a local single-user Factory from its local connection', async () => {
    const writes = registerSetup();
    server.use(http.get(`${TEST_BASE_URL}/auth/me`, () => new HttpResponse(null, { status: 404 })));
    persistOnboardingDraft({ repository: repo });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'model-provider');
    const user = userEvent.setup();
    renderOnboarding();
    await user.click(await screen.findByRole('button', { name: 'OpenAI' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('button', { name: 'Edit setup' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Create factory' }));
    await screen.findByRole('heading', { name: 'Factory ready' });
    expect(writes.find(item => item.path === 'create')?.body).toEqual({ name: repo.name });
  });
});

describe('harness choice in onboarding', () => {
  function serveClaudeCode(claudeCode: boolean) {
    server.use(
      http.get(`${TEST_BASE_URL}/web/config/features`, () =>
        HttpResponse.json({ knowledge: false, mcp: false, claudeCode }),
      ),
      http.get(`${TEST_BASE_URL}/web/config/providers/anthropic/accounts`, () =>
        HttpResponse.json({ accounts: [] }),
      ),
    );
  }

  it('asks for the harness after the codebase and, for Claude Code, a Claude model instead of a provider', async () => {
    serveClaudeCode(true);
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'vcs');
    const writes = registerSetup();
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('radio', { name: 'octo/hello' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Choose the harness.' })).toBeInTheDocument();
    expect(screen.getByText(/switch the harness later in Settings → Models/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Factory setup progress')).getByText('Harness')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Claude Code.*Claude subscription/ }));

    // Claude Code's sign-in and Claude model rows, no Mastra provider list.
    expect(await screen.findByRole('heading', { name: 'Choose your Claude model.' })).toBeInTheDocument();
    // No machine login to fall back on: an account is asked for.
    expect(await screen.findByText(/Claude Code needs a Claude sign-in to run/)).toBeInTheDocument();
    expect(screen.queryByText(/`claude` login/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OpenAI' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Sonnet/ }));

    const review = within(await screen.findByRole('region', { name: 'Review factory setup' }));
    expect(review.getByText('Claude Code')).toBeInTheDocument();
    expect(review.getByText('Sonnet')).toBeInTheDocument();
    expect(writes).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
    expect(writes.filter(item => item.path === 'create')).toEqual([
      { path: 'create', body: { name: 'hello', harness: 'claude-code', claudeCodeModel: 'sonnet' } },
    ]);
    // No Mastra default model is written for a Claude Code Factory.
    expect(writes.filter(item => item.path === 'model')).toEqual([]);
  }, 20_000);

  it('switches back to Mastra from review and asks for a provider model again', async () => {
    serveClaudeCode(true);
    persistOnboardingDraft({ repository: repo, harness: 'claude-code', claudeCodeModel: null });
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'review');
    const writes = registerSetup();
    const user = userEvent.setup();
    renderOnboarding();

    const review = within(await screen.findByRole('region', { name: 'Review factory setup' }));
    expect(review.getByText('Claude Code default')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit harness' }));
    await user.click(await screen.findByRole('option', { name: /Mastra.*Any model/ }));

    expect(await screen.findByRole('heading', { name: 'Choose your model.' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'OpenAI' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Ready to create.' });
    await user.click(screen.getByRole('button', { name: 'Create factory' }));
    expect(await screen.findByRole('heading', { name: 'Factory ready' })).toBeInTheDocument();
    expect(writes.filter(item => item.path === 'create')).toEqual([{ path: 'create', body: { name: 'hello' } }]);
    expect(writes.find(item => item.path === 'model')?.body).toEqual({ defaultModelId: model.modelId });
  }, 20_000);

  it('has no harness step when the server does not run Claude Code', async () => {
    serveClaudeCode(false);
    sessionStorage.setItem(ONBOARDING_STEP_KEY, 'vcs');
    registerSetup();
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('radio', { name: 'octo/hello' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Choose your model.' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('Factory setup progress')).queryByText('Harness')).not.toBeInTheDocument();
  });
});
