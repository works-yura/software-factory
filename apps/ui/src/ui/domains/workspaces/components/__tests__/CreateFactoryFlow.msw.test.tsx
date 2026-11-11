/**
 * BDD coverage for the inline `/factories/:factoryId/new-factory` wizard: Name →
 * Harness (only when the server runs Claude Code) → VCS (GitHub repo) → Model provider (default
 * model), each step rendered as a searchable command palette. Every pick lives
 * in a sessionStorage draft — so a full-page OAuth redirect resumes the flow,
 * and quitting halfway leaves nothing on the server — until the model step
 * commits the whole thing.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders, waitForMutationsIdle } from '../../../../../../e2e/ui/render';
import type { GithubStatus } from '../../services/github';
import { CreateFactoryWizard } from '../create-factory/CreateFactoryWizard';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const STEP_KEY = 'mastracode.factory-create.step';
const NAME_KEY = 'mastracode.factory-create.name';
const HARNESS_KEY = 'mastracode.factory-create.harness';
const REPO_KEY = 'mastracode.factory-create.repository';
const FACTORY_KEY = 'mastracode.factory-create.factory-id';
const LINKED_KEY = 'mastracode.factory-create.linked-repositories';
const WIZARD_PATH = '/factories/fp-host/new-factory';

const connectedGithub: GithubStatus = {
  enabled: true,
  connected: true,
  installations: [{ installationId: 7, accountLogin: 'octo', accountType: 'User' }],
  reason: 'ready',
};

const repo = {
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

function LocationProbe() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

function renderFlow(initialEntries: string[] = [WIZARD_PATH]) {
  return renderWithProviders(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <Routes>
        <Route path="/factories/:factoryId/new-factory" element={<CreateFactoryWizard />} />
        <Route path="*" element={<></>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Create Factory wizard', () => {
  it('starts on the name step, with the create row disabled until a name is typed', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })));

    renderFlow();

    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
    expect(screen.getByLabelText('Name your new Factory')).toHaveFocus();
    expect(screen.getByRole('option', { name: /Type a name to create your Factory/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await userEvent.setup().type(screen.getByLabelText('Name your new Factory'), 'Mastra');
    expect(screen.getByRole('option', { name: /Create “Mastra”/ })).toHaveAttribute('aria-disabled', 'false');
  });

  it('carries the typed name to the repository step without creating anything yet', async () => {
    const creates: unknown[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.post(`${TEST_BASE_URL}/web/factory/projects`, async ({ request }) => {
        creates.push(await request.json());
        return HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra' } });
      }),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    const user = userEvent.setup();

    renderFlow();

    const field = await screen.findByLabelText('Name your new Factory');
    expect(screen.getByRole('combobox', { name: 'Name your new Factory' })).toBe(field);
    await user.type(field, 'Mastra');
    await user.click(screen.getByRole('option', { name: /Create “Mastra”/ }));

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose your codebase' })).toBe(field);
    // The same field carries over, focused and empty — steps swap rows, not the palette.
    expect(screen.getByLabelText('Choose your codebase')).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
    // Nothing exists server-side yet: quitting here leaves no empty Factory behind.
    expect(creates).toEqual([]);
    // Persisted for the GitHub OAuth round-trip.
    expect(sessionStorage.getItem(STEP_KEY)).toBe('vcs');
    expect(sessionStorage.getItem(NAME_KEY)).toBe('Mastra');
  });

  it('loads the repository list while the name is still being typed', async () => {
    let repoRequests = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => {
        repoRequests += 1;
        return HttpResponse.json({ repos: [repo] });
      }),
    );
    const user = userEvent.setup();

    renderFlow();

    await screen.findByLabelText('Name your new Factory');
    await waitFor(() => expect(repoRequests).toBe(1));

    await user.type(await screen.findByLabelText('Name your new Factory'), 'Mastra{Enter}');

    // Already cached: the repository step opens on rows, not on a skeleton.
    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /octo\/hello/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading repositories')).not.toBeInTheDocument();
  });

  it('debounces repository searches before requesting filtered results', async () => {
    const queries: string[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('q') ?? '');
        return HttpResponse.json({ repos: [repo] });
      }),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();

    await screen.findByLabelText('Name your new Factory');
    await waitForMutationsIdle(client);
    expect(queries).toEqual(['']);
    await user.type(await screen.findByLabelText('Name your new Factory'), 'Mastra{Enter}');
    const search = await screen.findByLabelText('Choose your codebase');
    await waitForMutationsIdle(client);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    queries.splice(0);

    const deliberateUser = userEvent.setup({ delay: 350 });
    await deliberateUser.type(search, 'jal');

    expect(queries).toEqual([]);
    await act(() => new Promise(resolve => setTimeout(resolve, 800)));
    await waitForMutationsIdle(client);
    expect(queries).toEqual(['jal']);
  });

  it('submits the typed name with Enter', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    const user = userEvent.setup();

    renderFlow();

    await user.type(await screen.findByLabelText('Name your new Factory'), 'Mastra{Enter}');

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
  });

  it('keeps the picked repository in the draft instead of linking it right away', async () => {
    const calls: string[] = [];
    seedDraft('vcs');
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects`, () => {
        calls.push('create');
        return HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra' } });
      }),
    );
    const user = userEvent.setup();

    renderFlow();

    await pickRepositories(user, /octo\/hello/);

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(sessionStorage.getItem(STEP_KEY)).toBe('model-provider');
    expect(JSON.parse(sessionStorage.getItem(REPO_KEY) ?? 'null')).toMatchObject([{ fullName: 'octo/hello' }]);
  });

  it('creates the Factory, links the repository and saves the model on the last step', async () => {
    const calls: string[] = [];
    seedDraft('model-provider');
    const { patchedBodies, intakeConfigs, createdBodies } = stubModelStepEndpoints(calls);
    const user = userEvent.setup();

    const { client } = renderFlow();

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(sessionStorage.getItem(STEP_KEY)).toBe('model-provider');
    // Still nothing server-side one step before the end.
    expect(calls).toEqual([]);

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    await waitForMutationsIdle(client);
    expect(calls).toEqual(['create', 'connect', 'link']);
    // No harness step on this deployment, so the Factory runs on Mastra.
    expect(createdBodies).toEqual([{ name: 'Mastra', harness: 'mastra' }]);
    expect(patchedBodies).toEqual([{ instanceId: 'mastra', model: 'anthropic/claude-sonnet-4-5' }]);
    // The picked repository feeds Work intake without a trip to Settings.
    expect(intakeConfigs).toEqual([
      {
        github: { enabled: true, sourceIds: ['octo/hello'] },
        gitlab: { enabled: false, sourceIds: null },
        clickup: { enabled: false, sourceIds: null },
      },
    ]);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/factories/fp-1');
    expect(sessionStorage.getItem(STEP_KEY)).toBeNull();
  });

  it('skips the intake write when the repository already feeds issue intake', async () => {
    const calls: string[] = [];
    seedDraft('model-provider');
    const { intakeConfigs } = stubModelStepEndpoints(calls, {
      github: { enabled: true, sourceIds: ['octo/hello'] },
      gitlab: { enabled: false, sourceIds: null },
    });
    const user = userEvent.setup();

    const { client } = renderFlow();

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    await waitForMutationsIdle(client);
    // A retry or a second Factory over the same repo must not rewrite the selection.
    expect(intakeConfigs).toEqual([]);
  });

  it('resumes a failed commit without creating a second Factory', async () => {
    const calls: string[] = [];
    let linkFails = true;
    seedDraft('model-provider');
    const { patchedBodies } = stubModelStepEndpoints(calls);
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`, () => {
        if (linkFails) return HttpResponse.json({ error: 'nope' }, { status: 500 });
        calls.push('link');
        return HttpResponse.json({ projectRepository: linkedRepository });
      }),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sessionStorage.getItem(FACTORY_KEY)).toBe('fp-1');

    linkFails = false;
    await user.click(screen.getByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    await waitForMutationsIdle(client);
    expect(patchedBodies).toHaveLength(1);
    // The Factory created by the first attempt is reused, not duplicated.
    expect(calls).toEqual(['create', 'connect', 'connect', 'link']);
  });

  it('freezes the picks a failed commit already wrote to the server', async () => {
    const calls: string[] = [];
    seedDraft('model-provider');
    stubModelStepEndpoints(calls);
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`, () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    renderFlow();

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sessionStorage.getItem(FACTORY_KEY)).toBe('fp-1');
  });

  it('cannot be left while the Factory is being created', async () => {
    const calls: string[] = [];
    seedDraft('model-provider');
    stubModelStepEndpoints(calls);
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects`, () => {
        calls.push('create-pending');
        return new Promise<never>(() => {});
      }),
    );
    const user = userEvent.setup();

    renderFlow();

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    await waitFor(() => expect(calls).toContain('create-pending'));
    expect(screen.queryByRole('button', { name: 'Codebase' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(screen.getByTestId('pathname')).toHaveTextContent(WIZARD_PATH);
  });

  it('offers to connect GitHub when no installation is reachable', async () => {
    seedDraft('vcs');
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [], reason: 'not_connected' }),
      ),
    );

    renderFlow();

    expect(await screen.findByRole('option', { name: /Connect GitHub/ })).toHaveAttribute('aria-disabled', 'false');
  });

  it('marks GitHub unavailable and does not leak env details when the GitHub App is not configured', async () => {
    seedDraft('vcs');
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: false,
          connected: false,
          installations: [],
          reason: 'missing_config',
          diagnostics: { missingGithubAppEnvVars: ['GITHUB_APP_ID'] },
        }),
      ),
    );

    renderFlow();

    const row = await screen.findByRole('option', { name: /GitHub unavailable/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('GitHub is not configured for this deployment.');
    expect(row).not.toHaveTextContent('GITHUB_APP_ID');
  });

  it('lets a GitLab-only deployment choose a GitLab repository', async () => {
    seedDraft('vcs');
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: false,
          connected: false,
          installations: [],
          reason: 'missing_config',
          diagnostics: { missingGithubAppEnvVars: ['GITHUB_APP_ID'] },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({
          enabled: true,
          configured: true,
          accounts: ['gitlab.com'],
          reauthRequired: false,
          reason: 'ready',
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: 'gitlab-project:encoded',
              name: 'acme/app',
              projectId: '10',
              projectPath: 'acme/app',
              installationStorageId: 'gitlab-inst-1',
              connectionId: 'direct',
              accountLabel: 'gitlab.com',
              defaultBranch: 'main',
              sandboxProvider: 'local',
              sandboxWorkdir: '/workspace/app',
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();

    renderFlow();

    await pickRepositories(user, /acme\/app/);

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(REPO_KEY) ?? 'null')).toMatchObject([
      {
        provider: 'gitlab',
        id: 'gitlab-project:encoded',
        externalId: '10',
        fullName: 'acme/app',
      },
    ]);
  });

  it('restarts at the name step when the stored draft has no repository to commit', async () => {
    sessionStorage.setItem(STEP_KEY, 'model-provider');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    sessionStorage.setItem(FACTORY_KEY, 'fp-ghost');
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    const user = userEvent.setup();

    renderFlow();

    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();

    // Restarting drops what an earlier attempt half-created, so the run ahead is a clean one.
    await user.click(screen.getByRole('option', { name: /Create “Mastra”/ }));
    await screen.findByLabelText('Choose your codebase');
    expect(sessionStorage.getItem(FACTORY_KEY)).toBeNull();
  });

  it('shows the server error inline when the final create fails', async () => {
    seedDraft('model-provider');
    stubModelStepEndpoints([]);
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ error: 'Factory creation is unavailable' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    renderFlow();

    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to create Factory (500)');
    expect(screen.getByLabelText('Choose your Factory model')).toBeInTheDocument();
  });

  it('Escape falls back to the Factory in view when there is no in-app history (deep link)', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })));
    const user = userEvent.setup();

    renderFlow();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/factories/fp-host'));
  });
});

const linkedRepository = {
  id: 'ghp_1',
  branch: 'main',
  sandboxWorkdir: '/workspace/hello',
  repository: { slug: 'octo/hello', defaultBranch: 'main' },
};

/**
 * Stub the intake config the last step reads and writes, collecting every
 * saved config body. Stateful: each PUT becomes what the next GET returns.
 */
function stubIntakeConfig(initial: Record<string, unknown> = {}) {
  let config = initial;
  const savedConfigs: unknown[] = [];
  server.use(
    http.get(`${TEST_BASE_URL}/web/intake/config`, () => HttpResponse.json({ config })),
    http.put<never, Record<string, unknown>>(`${TEST_BASE_URL}/web/intake/config`, async ({ request }) => {
      config = await request.json();
      savedConfigs.push(config);
      return HttpResponse.json({ config });
    }),
  );
  return savedConfigs;
}

/**
 * Stub everything the last step writes: the Factory create, the repository
 * link, the intake wiring and the PATCH that saves the model pick — plus the
 * provider catalog the step lists. `calls`
 * records the write order; the returned arrays collect the PATCH and intake
 * bodies.
 */
function stubModelStepEndpoints(calls: string[], intakeConfig: Record<string, unknown> = {}) {
  const patchedBodies: unknown[] = [];
  const createdBodies: unknown[] = [];
  const intakeConfigs = stubIntakeConfig(intakeConfig);
  let savedModelId: string | null = null;
  let created = false;
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: created ? [{ id: 'fp-1', name: 'Mastra', repositories: [] }] : [] }),
    ),
    http.post(`${TEST_BASE_URL}/web/factory/projects`, async ({ request }) => {
      calls.push('create');
      createdBodies.push(await request.json());
      created = true;
      return HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra' } });
    }),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
      HttpResponse.json({ connections: [] }),
    ),
    http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () => {
      calls.push('connect');
      return HttpResponse.json({ connection: { id: 'conn-1' } });
    }),
    http.post(
      `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
      async ({ request }) => {
        calls.push('link');
        expect(await request.json()).toMatchObject({
          repository: { externalId: '99', slug: 'octo/hello' },
          branch: 'main',
        });
        return HttpResponse.json({ projectRepository: linkedRepository });
      },
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1`, () =>
      HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra', defaultModelId: savedModelId } }),
    ),
    http.put<{ instanceId: string }, { model: string }>(
      `${TEST_BASE_URL}/web/factory/projects/fp-1/model-defaults/:instanceId`,
      async ({ request, params }) => {
        const body = await request.json();
        patchedBodies.push({ instanceId: params.instanceId, ...body });
        if (params.instanceId === 'mastra') savedModelId = body.model;
        return HttpResponse.json({ project: { id: 'fp-1', name: 'Mastra', defaultModelId: savedModelId } });
      },
    ),
    http.get(`${TEST_BASE_URL}/web/config/providers`, () =>
      HttpResponse.json({
        providers: [{ provider: 'anthropic', source: 'stored', oauth: { supported: true, modes: ['paste-code'] } }],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({
        models: [
          { id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', modelName: 'claude-sonnet-4-5', hasApiKey: true },
        ],
      }),
    ),
  );
  return { patchedBodies, intakeConfigs, createdBodies };
}

describe('back navigation', () => {
  it('has no back button on the name step', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })));

    renderFlow();

    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go back to previous step/ })).not.toBeInTheDocument();
  });

  it('steps back from vcs to name while preserving the typed name', async () => {
    seedDraft('vcs');
    const user = userEvent.setup();

    renderFlow();

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));

    // Back returns to the name step, and the previously typed name is still in the draft.
    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
    expect(sessionStorage.getItem(STEP_KEY)).toBe('name');
    expect(sessionStorage.getItem(NAME_KEY)).toBe('Mastra');
  });

  it('drops the back button once a Factory has been created but the final commit failed', async () => {
    // The final commit on model-provider persists `factoryId` (and possibly
    // `linkedRepositoryId`) so a retry resumes instead of duplicating. If the
    // user could still step back, they might pick a new name or repository
    // while the retry silently finishes the prior IDs, so Back is removed
    // once these server-side checkpoints exist.
    seedDraft('model-provider');
    sessionStorage.setItem(FACTORY_KEY, 'fp-existing');
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-existing', name: 'Mastra', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/om`, () => HttpResponse.json({})),
    );

    renderFlow();

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go back to previous step/ })).not.toBeInTheDocument();
  });

  it('also drops the back button when only the repository link has been persisted', async () => {
    seedDraft('model-provider');
    sessionStorage.setItem(LINKED_KEY, JSON.stringify(['github:octo/hello']));
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/om`, () => HttpResponse.json({})),
    );

    renderFlow();

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go back to previous step/ })).not.toBeInTheDocument();
  });

  it('preserves the repository pick when Back rewinds through name back to vcs', async () => {
    seedDraft('model-provider');
    const user = userEvent.setup();

    renderFlow();

    // Back twice: model-provider → vcs → name. The repository the user
    // already picked must survive the rewind so it is still there when they
    // continue back to vcs.
    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));
    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));
    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();

    // The repository pick is still in sessionStorage after landing on name.
    expect(sessionStorage.getItem(STEP_KEY)).toBe('name');
    expect(sessionStorage.getItem(REPO_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(NAME_KEY)).toBe('Mastra');
  });
});

/** Seed a mid-flow draft: name typed, repository picked, nothing created yet. */
function seedDraft(step: 'vcs' | 'model-provider') {
  sessionStorage.setItem(STEP_KEY, step);
  sessionStorage.setItem(NAME_KEY, 'Mastra');
  if (step !== 'vcs') sessionStorage.setItem(REPO_KEY, JSON.stringify(repo));
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
    http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
    http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
  );
}

/** Report the Claude Code harness as configured (or not) on this server, and whether it runs on the local login. */
function serveClaudeCodeFeature(claudeCode: boolean, { claudeSignIn = false } = {}) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/features`, () =>
      HttpResponse.json({ knowledge: false, mcp: false, claudeCode, claudeSignIn }),
    ),
  );
}

/** The organization's Claude sign-ins, and pasted tokens left from before (which run nothing). */
function serveClaudeAccounts(count: number, legacy = 0) {
  const row = (index: number, old: boolean) => ({
    id: `acct-${old ? 'old-' : ''}${index}`,
    label: `Account ${old ? 'old ' : ''}${index}`,
    kind: old ? 'api_key' : 'claude_login',
    mine: true,
    priority: index,
    status: 'active',
    hint: '',
    canManage: true,
    legacy: old,
    createdAt: '2026-10-01T10:00:00.000Z',
  });
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/providers/anthropic/accounts`, () =>
      HttpResponse.json({
        accounts: [
          ...Array.from({ length: count }, (_, index) => row(index, false)),
          ...Array.from({ length: legacy }, (_, index) => row(index, true)),
        ],
      }),
    ),
  );
}

/** No Mastra provider row is on the Claude Code step. */
function expectNoProviderRows() {
  expect(screen.queryByRole('option', { name: /^Anthropic/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Sign in with your account')).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /anthropic\/claude-sonnet-4-5/ })).not.toBeInTheDocument();
}

/** Pick repositories on the codebase step, then go on with them. */
async function pickRepositories(user: ReturnType<typeof userEvent.setup>, ...names: RegExp[]) {
  for (const name of names) await user.click(await screen.findByRole('option', { name }));
  await user.click(await screen.findByRole('option', { name: /^Continue with \d+ repositor/ }));
}

async function finishOnModelStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
  await user.click(await screen.findByRole('option', { name: /anthropic\/claude-sonnet-4-5/ }));
}

describe('harness step', () => {
  it('asks which harness to run on between the name and the codebase, then sends the pick on create', async () => {
    const calls: string[] = [];
    serveClaudeCodeFeature(true);
    const { createdBodies, patchedBodies } = stubModelStepEndpoints(calls);
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();

    await user.type(await screen.findByLabelText('Name your new Factory'), 'Mastra');
    await user.click(await screen.findByRole('option', { name: /Create “Mastra”/ }));

    expect(await screen.findByLabelText('Choose how your agents run')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Step 2 of 4' })).toBeInTheDocument();
    expect(
      screen.getByText(/switch the harness later in Settings → Models; the switch applies to new sessions/),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Mastra.*Any model/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Claude Code.*Claude subscription/ }));

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    expect(sessionStorage.getItem(HARNESS_KEY)).toBe('claude-code');
    expect(calls).toEqual([]);

    await pickRepositories(user, /octo\/hello/);

    // The last step is Claude Code's own: a Claude model, no Mastra provider to connect.
    expect(await screen.findByLabelText('Choose your Claude model')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Step 4 of 4' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude Code default/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Sonnet/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Haiku/ })).toBeInTheDocument();
    expectNoProviderRows();
    await user.click(screen.getByRole('option', { name: /Opus/ }));

    await waitForMutationsIdle(client);
    expect(createdBodies).toEqual([{ name: 'Mastra', harness: 'claude-code' }]);
    // The Claude model is the Factory's Claude Code default; no Mastra default is written.
    expect(patchedBodies).toEqual([{ instanceId: 'claude-code', model: 'opus' }]);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/factories/fp-1');
    expect(sessionStorage.getItem(HARNESS_KEY)).toBeNull();
  });

  it('creates a Mastra Factory when Mastra is picked', async () => {
    serveClaudeCodeFeature(true);
    sessionStorage.setItem(STEP_KEY, 'harness');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    const { createdBodies } = stubModelStepEndpoints([]);
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();

    await user.click(await screen.findByRole('option', { name: /Mastra.*Any model/ }));
    await pickRepositories(user, /octo\/hello/);
    await finishOnModelStep(user);

    await waitForMutationsIdle(client);
    expect(createdBodies).toEqual([{ name: 'Mastra', harness: 'mastra' }]);
  });

  it('skips the harness step when the server has no Claude Code harness', async () => {
    serveClaudeCodeFeature(false);
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo] })),
    );
    // A stale pick from an earlier run must not leak into this Factory.
    sessionStorage.setItem(HARNESS_KEY, 'claude-code');
    const user = userEvent.setup();

    renderFlow();

    expect(await screen.findByRole('list', { name: 'Step 1 of 3' })).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Name your new Factory'), 'Mastra');
    await user.click(await screen.findByRole('option', { name: /Create “Mastra”/ }));

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose how your agents run')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Step 2 of 3' })).toBeInTheDocument();
    expect(sessionStorage.getItem(HARNESS_KEY)).toBeNull();

    // Back from the codebase goes straight to the name.
    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));
    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
  });

  it('keeps the harness pick across a reload and creates on the Claude Code default model', async () => {
    serveClaudeCodeFeature(true);
    seedDraft('model-provider');
    sessionStorage.setItem(HARNESS_KEY, 'claude-code');
    const { createdBodies, patchedBodies } = stubModelStepEndpoints([]);
    const user = userEvent.setup();

    const { client } = renderFlow();

    await user.click(await screen.findByRole('option', { name: /Claude Code default/ }));

    await waitForMutationsIdle(client);
    expect(createdBodies).toEqual([{ name: 'Mastra', harness: 'claude-code' }]);
    // The CLI's own default: the Factory follows the Claude Code catalog default.
    expect(patchedBodies).toEqual([]);
  });

  it('keeps the Mastra model step for a Mastra Factory: providers first, then the model', async () => {
    serveClaudeCodeFeature(true);
    seedDraft('model-provider');
    sessionStorage.setItem(HARNESS_KEY, 'mastra');
    const { createdBodies, patchedBodies } = stubModelStepEndpoints([]);
    const user = userEvent.setup();

    const { client } = renderFlow();

    expect(await screen.findByLabelText('Choose your Factory model')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Claude Code default/ })).not.toBeInTheDocument();
    await finishOnModelStep(user);

    await waitForMutationsIdle(client);
    expect(createdBodies).toEqual([{ name: 'Mastra', harness: 'mastra' }]);
    expect(patchedBodies).toEqual([{ instanceId: 'mastra', model: 'anthropic/claude-sonnet-4-5' }]);
  });

  describe('Claude Code sign-in on the model step', () => {
    it('asks for an account in local development too: the machine’s own claude login is never used', async () => {
      serveClaudeCodeFeature(true, { claudeSignIn: true });
      serveClaudeAccounts(0);
      seedDraft('model-provider');
      sessionStorage.setItem(HARNESS_KEY, 'claude-code');
      stubModelStepEndpoints([]);

      renderFlow();

      expect(await screen.findByText(/Claude Code needs a Claude sign-in to run/)).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Sign in with Claude/ })).toBeInTheDocument();
      expect(screen.queryByText(/`claude` login/)).not.toBeInTheDocument();
      expectNoProviderRows();
    });

    it('says a Claude sign-in is needed when there is none, and offers no token to paste', async () => {
      serveClaudeCodeFeature(true);
      serveClaudeAccounts(0);
      seedDraft('model-provider');
      sessionStorage.setItem(HARNESS_KEY, 'claude-code');
      stubModelStepEndpoints([]);

      renderFlow();

      expect(await screen.findByText(/Claude Code needs a Claude sign-in to run\./)).toBeInTheDocument();
      expect(screen.getByText(/sign in any time in Settings → Models → Claude Code accounts/)).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Add a Claude Code account/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/`claude` login/)).not.toBeInTheDocument();
    });

    it('offers signing in with Claude when there is no account, and reports the sign-in', async () => {
      serveClaudeCodeFeature(true, { claudeSignIn: true });
      serveClaudeAccounts(0);
      seedDraft('model-provider');
      sessionStorage.setItem(HARNESS_KEY, 'claude-code');
      stubModelStepEndpoints([]);
      const started: string[] = [];
      server.use(
        http.post(`${TEST_BASE_URL}/web/config/providers/anthropic/accounts/sign-in`, () => {
          started.push('start');
          return HttpResponse.json({ signIn: { id: 'flow-1', status: 'pending' } }, { status: 202 });
        }),
        http.get(`${TEST_BASE_URL}/web/config/providers/anthropic/accounts/sign-in/:id`, () =>
          HttpResponse.json({ signIn: { id: 'flow-1', status: 'error', error: 'Claude sign-in did not finish.' } }),
        ),
      );
      const user = userEvent.setup();

      renderFlow();

      await user.click(await screen.findByRole('option', { name: /Sign in with Claude/ }));
      expect(await screen.findByText('Claude sign-in did not finish.')).toBeInTheDocument();
      expect(started).toEqual(['start']);
    });

    it('counts the organization’s sign-ins, leaving old pasted tokens out', async () => {
      serveClaudeCodeFeature(true, { claudeSignIn: true });
      serveClaudeAccounts(2, 1);
      seedDraft('model-provider');
      sessionStorage.setItem(HARNESS_KEY, 'claude-code');
      stubModelStepEndpoints([]);

      renderFlow();

      expect(await screen.findByText(/Runs on your organization’s 2 Claude Code accounts\./)).toBeInTheDocument();
      // Sign-ins already there: no sign-in offered on top of them, and nothing to paste.
      expect(screen.queryByRole('option', { name: /Sign in with Claude/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Add a Claude Code account/ })).not.toBeInTheDocument();
    });

    it('offers signing in when only old pasted tokens are left', async () => {
      serveClaudeCodeFeature(true, { claudeSignIn: true });
      serveClaudeAccounts(0, 2);
      seedDraft('model-provider');
      sessionStorage.setItem(HARNESS_KEY, 'claude-code');
      stubModelStepEndpoints([]);

      renderFlow();

      expect(await screen.findByText(/Claude Code needs a Claude sign-in to run/)).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Sign in with Claude/ })).toBeInTheDocument();
    });
  });

  it('steps back from the codebase to the harness step with the pick still marked', async () => {
    serveClaudeCodeFeature(true);
    seedDraft('vcs');
    sessionStorage.setItem(HARNESS_KEY, 'claude-code');
    const user = userEvent.setup();

    renderFlow();

    expect(await screen.findByLabelText('Choose your codebase')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));

    expect(await screen.findByLabelText('Choose how your agents run')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude Code/ })).toHaveTextContent('Selected');
    expect(screen.getByRole('option', { name: /Mastra.*Any model/ })).not.toHaveTextContent('Selected');
    expect(sessionStorage.getItem(STEP_KEY)).toBe('harness');

    await user.click(screen.getByRole('button', { name: /Go back to previous step/ }));
    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
    expect(sessionStorage.getItem(HARNESS_KEY)).toBe('claude-code');
  });

  it('restarts at the name step when a stored harness step has no name', async () => {
    serveClaudeCodeFeature(true);
    sessionStorage.setItem(STEP_KEY, 'harness');
    server.use(http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })));

    renderFlow();

    expect(await screen.findByLabelText('Name your new Factory')).toBeInTheDocument();
  });
});

describe('several repositories', () => {
  const second = {
    ...repo,
    id: 100,
    fullName: 'octo/web',
    name: 'web',
    sandboxWorkdir: '/workspace/web',
  };

  function serveTwoRepositories() {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
      http.get(`${TEST_BASE_URL}/web/github/status`, () => HttpResponse.json(connectedGithub)),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () => HttpResponse.json({ repos: [repo, second] })),
    );
  }

  it('keeps picking on the codebase step, marks every pick alike (no main repository) and drops a repository picked again', async () => {
    sessionStorage.setItem(STEP_KEY, 'vcs');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    serveTwoRepositories();
    const user = userEvent.setup();

    renderFlow();

    await user.click(await screen.findByRole('option', { name: /octo\/hello/ }));
    await user.click(await screen.findByRole('option', { name: /octo\/web/ }));

    expect(await screen.findByRole('option', { name: /^Continue with 2 repositories/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /octo\/hello.*Selected/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /octo\/web.*Selected/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Choose your codebase')).toBeInTheDocument();
    expect(sessionStorage.getItem(STEP_KEY)).toBe('vcs');

    // The continue row lists the picks too, so match the repository row by its title.
    await user.click(screen.getByRole('option', { name: /^octo\/hello/ }));

    expect(await screen.findByRole('option', { name: /^Continue with 1 repository/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /octo\/web.*Selected/ })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(REPO_KEY) ?? 'null')).toMatchObject([{ fullName: 'octo/web' }]);
  });

  it('offers no way on until a repository is picked', async () => {
    sessionStorage.setItem(STEP_KEY, 'vcs');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    serveTwoRepositories();

    renderFlow();

    expect(await screen.findByRole('option', { name: /octo\/hello/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Continue with/ })).not.toBeInTheDocument();
  });

  it('links every picked repository in pick order when the last step commits', async () => {
    const calls: string[] = [];
    sessionStorage.setItem(STEP_KEY, 'model-provider');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    sessionStorage.setItem(REPO_KEY, JSON.stringify([second, repo]));
    stubModelStepEndpoints(calls);
    const linkedSlugs: string[] = [];
    server.use(
      http.post(
        `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
        async ({ request }) => {
          calls.push('link');
          linkedSlugs.push(((await request.json()) as { repository: { slug: string } }).repository.slug);
          return HttpResponse.json({ projectRepository: linkedRepository });
        },
      ),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();
    await finishOnModelStep(user);
    await waitForMutationsIdle(client);

    expect(linkedSlugs).toEqual(['octo/web', 'octo/hello']);
    expect(calls.filter(call => call === 'create')).toHaveLength(1);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/factories/fp-1');
  });

  it('on retry only links the repositories that are not linked yet', async () => {
    const calls: string[] = [];
    sessionStorage.setItem(STEP_KEY, 'model-provider');
    sessionStorage.setItem(NAME_KEY, 'Mastra');
    sessionStorage.setItem(FACTORY_KEY, 'fp-1');
    sessionStorage.setItem(REPO_KEY, JSON.stringify([repo, second]));
    sessionStorage.setItem(LINKED_KEY, JSON.stringify(['github:octo/hello']));
    stubModelStepEndpoints(calls);
    const linkedSlugs: string[] = [];
    server.use(
      http.post(
        `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`,
        async ({ request }) => {
          linkedSlugs.push(((await request.json()) as { repository: { slug: string } }).repository.slug);
          return HttpResponse.json({ projectRepository: linkedRepository });
        },
      ),
    );
    const user = userEvent.setup();

    const { client } = renderFlow();
    await finishOnModelStep(user);
    await waitForMutationsIdle(client);

    expect(linkedSlugs).toEqual(['octo/web']);
    expect(calls).not.toContain('create');
  });
});
