import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { GitLabProject, GitLabStatus } from '../../../factory/services/gitlab';
import type { IntakeConfig } from '../../../factory/services/intake';
import type { GithubStatus } from '../../../workspaces/services/github';
import { IntakeSection } from '../IntakeSection';

const CONFIG_URL = `${TEST_BASE_URL}/web/intake/config`;
const BINDINGS_URL = `${TEST_BASE_URL}/web/intake/bindings`;
const GITHUB_STATUS_URL = `${TEST_BASE_URL}/web/github/status`;
const GITLAB_STATUS_URL = `${TEST_BASE_URL}/web/gitlab/status`;
const GITLAB_PROJECTS_URL = `${TEST_BASE_URL}/web/gitlab/projects`;

function baseConfig(): IntakeConfig {
  return {
    github: { enabled: true, sourceIds: null },
    gitlab: { enabled: false, sourceIds: null },
  };
}

const githubReadyStatus: GithubStatus = {
  enabled: true,
  connected: true,
  installations: [{ installationId: 1, accountLogin: 'acme', accountType: 'Organization' }],
  reason: 'ready',
};

function seedGithubProject() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: 'fp-1', name: 'mastra' }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
      HttpResponse.json({
        connections: [
          {
            id: 'conn-fp-1',
            repositories: [
              {
                id: 'ghp-1',
                branch: null,
                sandboxWorkdir: null,
                repository: { slug: 'mastra', defaultBranch: 'main' },
              },
            ],
          },
        ],
      }),
    ),
  );
}

function useIntakeHandlers({
  config = baseConfig(),
  githubStatus = githubReadyStatus,
}: {
  config?: IntakeConfig;
  githubStatus?: GithubStatus;
} = {}) {
  const saved: IntakeConfig[] = [];
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json({ config })),
    http.put(CONFIG_URL, async ({ request }) => {
      const next = (await request.json()) as IntakeConfig;
      saved.push(next);
      return HttpResponse.json({ config: next });
    }),
    http.get(GITHUB_STATUS_URL, () => HttpResponse.json(githubStatus)),
    http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [] })),
  );
  return saved;
}

const gitlabReadyStatus: GitLabStatus = {
  enabled: true,
  configured: true,
  connections: [{ id: 'a1b_acme', integrationId: 'gitlab', status: 'active', accountLabel: 'acme' }],
  accounts: ['acme'],
  reauthRequired: false,
  reason: 'ready',
};

const gitlabProjects: GitLabProject[] = [
  {
    id: 'gitlab-project:encoded',
    name: 'acme/app',
    connectionId: 'a1b_acme',
    accountLabel: 'acme',
    defaultBranch: 'main',
  },
];

function useGitLabHandlers(config: IntakeConfig, status: GitLabStatus = gitlabReadyStatus) {
  const saved = useIntakeHandlers({ config });
  const savedBindings: Array<{
    integrationId: string;
    sourceId: string;
    factoryProjectId: string | null;
    board: string | null;
  }> = [];
  server.use(
    http.get(GITLAB_STATUS_URL, () => HttpResponse.json(status)),
    http.get(GITLAB_PROJECTS_URL, () => HttpResponse.json({ projects: gitlabProjects })),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Acme Web' }] }),
    ),
    http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: savedBindings })),
    http.put(BINDINGS_URL, async ({ request }) => {
      const body = (await request.json()) as (typeof savedBindings)[number];
      const index = savedBindings.findIndex(
        binding => binding.integrationId === body.integrationId && binding.sourceId === body.sourceId,
      );
      if (index === -1) savedBindings.push(body);
      else savedBindings[index] = body;
      return HttpResponse.json({ bindings: savedBindings });
    }),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () =>
      HttpResponse.json({
        boards: [{ id: 'work', title: 'Work', initialPhase: 'intake', phases: [] }],
      }),
    ),
  );
  return { saved, savedBindings };
}

function renderIntakeSection() {
  return renderWithProviders(
    <>
      <IntakeSection />
      <Toaster position="bottom-right" />
    </>,
  );
}

describe('IntakeSection', () => {
  describe('given a config with the default sources enabled', () => {
    it('lists every work intake source and expands the configured pickers', async () => {
      seedGithubProject();
      useIntakeHandlers();

      renderIntakeSection();

      expect(await screen.findByRole('switch', { name: 'Sync GitHub issues' })).toBeChecked();

      expect(await screen.findByRole('checkbox', { name: 'mastra' })).toBeInTheDocument();
    });

    it('shows how many items are selected', async () => {
      seedGithubProject();
      useIntakeHandlers({
        config: {
          github: { enabled: true, sourceIds: ['mastra'] },
          gitlab: { enabled: false, sourceIds: null },
        },
      });

      renderIntakeSection();

      // One count per source picker: the selected repository.
      await waitFor(() => expect(screen.getAllByText('1 selected')).toHaveLength(1));
    });
  });

  describe('when the GitHub source is toggled off', () => {
    it('persists the config with github disabled', async () => {
      seedGithubProject();
      const saved = useIntakeHandlers();

      renderIntakeSection();

      await userEvent.click(await screen.findByRole('switch', { name: 'Sync GitHub issues' }));

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0].github.enabled).toBe(false);
      expect(await screen.findByText('Intake sources updated')).toBeInTheDocument();
    });
  });

  describe('given GitHub is not configured on the server', () => {
    it('disables GitHub intake and hides repository controls', async () => {
      seedGithubProject();
      useIntakeHandlers({
        githubStatus: {
          enabled: false,
          connected: false,
          installations: [],
          reason: 'missing_config',
        },
      });

      renderIntakeSection();

      expect(await screen.findByText('GitHub is not configured on this server.')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Sync GitHub issues' })).toBeDisabled();
      expect(screen.queryByRole('checkbox', { name: 'mastra' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'GitHub routing' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });
  });

  describe('given the GitHub status endpoint fails', () => {
    it('reports the status as unavailable with a retry instead of claiming GitHub is not configured', async () => {
      seedGithubProject();
      useIntakeHandlers();
      const statusRequests: number[] = [];
      server.use(
        http.get(GITHUB_STATUS_URL, () => {
          statusRequests.push(statusRequests.length + 1);
          // First call fails; the retry reaches a healthy server.
          if (statusRequests.length === 1) return HttpResponse.json({ error: 'boom' }, { status: 500 });
          return HttpResponse.json(githubReadyStatus);
        }),
      );

      renderIntakeSection();

      expect(await screen.findByText('GitHub status could not be loaded.')).toBeInTheDocument();
      expect(screen.queryByText('GitHub is not configured on this server.')).not.toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Sync GitHub issues' })).toBeDisabled();
      expect(screen.queryByRole('checkbox', { name: 'mastra' })).not.toBeInTheDocument();
      expect(statusRequests).toHaveLength(1);

      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(statusRequests).toHaveLength(2));
      expect(await screen.findByRole('checkbox', { name: 'mastra' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Sync GitHub issues' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });
  });

  describe('when a GitHub repository is picked', () => {
    it('persists an explicit repository selection under sourceIds', async () => {
      seedGithubProject();
      const saved = useIntakeHandlers();

      renderIntakeSection();

      await userEvent.click(await screen.findByRole('checkbox', { name: 'mastra' }));

      await waitFor(() => expect(saved).toHaveLength(1));
      // The board and intake integrations key GitHub sources by repo slug (owner/name).
      expect(saved[0].github.sourceIds).toEqual(['mastra']);
      expect(saved[0]).not.toHaveProperty('github.repositoryIds');
    });
  });

  describe('given the server omits unregistered integrations', () => {
    // The server returns a dynamic map keyed by integration id and drops keys
    // for integrations that aren't registered, so the config can arrive as `{}`.
    // The fixed-shape reads must not crash on the missing `github`/`gitlab` keys.
    it('renders both sources with default toggles instead of crashing', async () => {
      seedGithubProject();
      server.use(
        http.get(CONFIG_URL, () => HttpResponse.json({ config: {} })),
        http.get(GITHUB_STATUS_URL, () =>
          HttpResponse.json({ enabled: false, connected: false, installations: [], reason: 'missing_config' }),
        ),
      );

      renderIntakeSection();

      // Missing provider entries stay off, and unavailable providers cannot be toggled on.
      expect(await screen.findByRole('switch', { name: 'Sync GitHub issues' })).not.toBeChecked();
      expect(screen.getByRole('switch', { name: 'Sync GitHub issues' })).toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Sync GitLab issues' })).not.toBeChecked();
    });
  });

  describe('given the config endpoint fails', () => {
    it('shows the unavailable notice', async () => {
      server.use(
        http.get(BINDINGS_URL, () => HttpResponse.json({ bindings: [] })),
        http.get(CONFIG_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
        http.get(GITHUB_STATUS_URL, () => HttpResponse.json(githubReadyStatus)),
      );

      renderIntakeSection();

      expect(await screen.findByText(/Intake configuration is unavailable/)).toBeInTheDocument();
    });
  });

  describe('given GitLab is configured', () => {
    it('does not offer a linked GitLab repository as a GitHub intake source', async () => {
      useGitLabHandlers({
        ...baseConfig(),
        gitlab: { enabled: true, sourceIds: null },
      });
      server.use(
        http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
          HttpResponse.json({
            connections: [
              {
                id: 'gitlab-connection',
                integrationId: 'gitlab',
                installationId: 'gitlab-installation',
                repositories: [
                  {
                    id: 'gitlab-link',
                    branch: 'main',
                    sandboxWorkdir: '~/app',
                    repository: { slug: 'acme/app', defaultBranch: 'main' },
                  },
                ],
              },
            ],
          }),
        ),
      );

      renderIntakeSection();

      const githubSection = await screen.findByRole('region', { name: 'GitHub issues' });
      expect(await within(githubSection).findByText(/No linked repositories yet/)).toBeInTheDocument();
      expect(within(githubSection).queryByRole('checkbox', { name: 'acme/app' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'GitHub routing' })).not.toBeInTheDocument();
      const gitlabProjects = await screen.findByRole('group', { name: 'GitLab projects' });
      expect(within(gitlabProjects).getByRole('checkbox', { name: 'acme/app' })).toBeInTheDocument();
    });

    it('selects a project and routes it to a Factory board', async () => {
      const { saved, savedBindings } = useGitLabHandlers({
        ...baseConfig(),
        gitlab: { enabled: true, sourceIds: null },
      });

      renderIntakeSection();

      expect(await screen.findByText('Connected to acme')).toBeInTheDocument();
      const projects = await screen.findByRole('group', { name: 'GitLab projects' });
      await userEvent.click(within(projects).getByRole('checkbox', { name: 'acme/app' }));

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0].gitlab.sourceIds).toEqual(['gitlab-project:encoded']);
      expect(await screen.findByText(/Not routed — this source's issues won't be picked up/)).toBeInTheDocument();

      await userEvent.click(await screen.findByLabelText('Factory for acme/app'));
      await userEvent.click(await screen.findByRole('option', { name: 'Acme Web' }));
      await userEvent.click(await screen.findByLabelText('Board for acme/app'));
      await userEvent.click(await screen.findByRole('option', { name: 'Work' }));

      await waitFor(() =>
        expect(savedBindings).toEqual([
          {
            integrationId: 'gitlab',
            sourceId: 'gitlab-project:encoded',
            factoryProjectId: 'fp-1',
            board: 'work',
          },
        ]),
      );
      expect((await screen.findAllByText('GitLab routing updated')).length).toBeGreaterThan(0);
    });

    it('keeps healthy projects available when another Platform connection needs reauthorization', async () => {
      useGitLabHandlers(
        { ...baseConfig(), gitlab: { enabled: true, sourceIds: null } },
        {
          ...gitlabReadyStatus,
          connections: [
            ...gitlabReadyStatus.connections!,
            { id: 'a1b_old', integrationId: 'gitlab', status: 'needs_reauth', accountLabel: 'old' },
          ],
          reauthRequired: true,
        },
      );

      renderIntakeSection();

      expect(
        await screen.findByText('A GitLab account needs to be reconnected in Mastra Platform.'),
      ).toBeInTheDocument();
      expect(await screen.findByRole('checkbox', { name: 'acme/app' })).toBeInTheDocument();
    });
  });
});
