import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { SandboxEnvFile, SandboxStage } from '../../../workspaces/services/sandbox-envs';
import { EnvironmentSection } from '../EnvironmentSection';
import { envFilePathProblem } from '../environment/RepositoryEnvFiles';
import { environmentPayload, environmentRepository, FACTORY_ID } from './fixtures/environment';

const FILES_URL = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sandbox-env-files`;
const SECRET = 'API_KEY=sentinel-secret\n';

interface RecordedRequest {
  method: string;
  id?: string;
  body: unknown;
}

function file(id: string, projectRepositoryId: string, path: string, stage: SandboxStage, size = SECRET.length) {
  return { id, projectRepositoryId, path, stage, size, updatedAt: '2026-11-09T12:00:00.000Z', updatedBy: 'admin' };
}

/** The env file routes in memory: lists never carry content; GET by id reveals it (admins). */
function useEnvFilesServer(initial: SandboxEnvFile[], options: { canManage?: boolean } = {}) {
  const files = new Map(initial.map(item => [item.id, { ...item, content: SECRET }]));
  const requests: RecordedRequest[] = [];
  const canManage = options.canManage ?? true;
  const strip = ({ content: _content, ...rest }: SandboxEnvFile & { content: string }) => rest;
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
      HttpResponse.json({
        environment: environmentPayload({
          repositories: [
            environmentRepository({ projectRepositoryId: 'web', position: 1 }),
            environmentRepository({ projectRepositoryId: 'mobile', position: 2 }),
          ],
        }),
      }),
    ),
    http.get(FILES_URL, () => HttpResponse.json({ files: [...files.values()].map(strip), writable: true, canManage })),
    http.get<{ id: string }>(`${FILES_URL}/:id`, ({ params }) => {
      requests.push({ method: 'GET', id: params.id, body: null });
      const found = files.get(params.id);
      if (!canManage) return HttpResponse.json({ error: 'organization_admin_required' }, { status: 403 });
      return found ? HttpResponse.json({ file: found }) : HttpResponse.json({}, { status: 404 });
    }),
    http.post<never, { projectRepositoryId: string; path: string; stage: SandboxStage; content: string }>(
      FILES_URL,
      async ({ request }) => {
        const body = await request.json();
        requests.push({ method: 'POST', body });
        const saved = { ...file(`f${files.size + 1}`, body.projectRepositoryId, body.path, body.stage), content: body.content };
        files.set(saved.id, saved);
        return HttpResponse.json({ file: strip(saved) });
      },
    ),
    http.patch<{ id: string }, { path?: string; stage?: SandboxStage; content?: string }>(
      `${FILES_URL}/:id`,
      async ({ params, request }) => {
        const body = await request.json();
        requests.push({ method: 'PATCH', id: params.id, body });
        const current = files.get(params.id)!;
        const saved = { ...current, ...body };
        files.set(params.id, saved);
        return HttpResponse.json({ file: strip(saved) });
      },
    ),
    http.delete<{ id: string }>(`${FILES_URL}/:id`, ({ params }) => {
      requests.push({ method: 'DELETE', id: params.id, body: null });
      files.delete(params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return requests;
}

function renderSettings() {
  return renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/environment`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/environment" element={<EnvironmentSection />} />
      </Routes>
      <Toaster position="bottom-right" />
    </MemoryRouter>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

async function openRepository(user: User, slug: string) {
  await user.click(await screen.findByRole('button', { name: `Show commands for ${slug}` }));
}

describe('Env files per repository', () => {
  it("lists only the opened repository's files, masked, with their stage", async () => {
    const requests = useEnvFilesServer([
      file('f1', 'mobile', 'apps/mobile/.env', 'development'),
      file('f2', 'mobile', '.env.staging', 'staging'),
      file('f3', 'web', '.env.production', 'production'),
    ]);
    const user = userEvent.setup();

    renderSettings();
    await openRepository(user, 'acme/mobile');

    const table = await screen.findByRole('table', { name: 'Env files of acme/mobile' });
    expect(within(table).getByText('apps/mobile/.env')).toBeInTheDocument();
    expect(within(table).getByLabelText('apps/mobile/.env stage')).toHaveTextContent('Development');
    expect(within(table).getByLabelText('.env.staging stage')).toHaveTextContent('Staging');
    expect(within(table).getByLabelText('.env.staging content hidden')).toHaveTextContent('••••••••••••');
    expect(within(table).queryByText('.env.production')).not.toBeInTheDocument();
    expect(screen.queryByText(/sentinel-secret/)).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('adds a file with POST after explaining a refused path', async () => {
    const requests = useEnvFilesServer([]);
    const user = userEvent.setup();

    renderSettings();
    await openRepository(user, 'acme/mobile');
    await user.click(await screen.findByRole('button', { name: 'Add env file to acme/mobile' }));
    const dialog = await screen.findByRole('dialog');
    const path = within(dialog).getByRole('textbox', { name: 'Path' });
    await user.type(path, '../.env');
    expect(within(dialog).getByText("The path can't leave the repository (..).")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(path);
    await user.type(path, 'ios/Config.xcconfig');
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Stage' })).getByRole('radio', { name: 'Staging' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Content' }), 'API_URL = https://staging');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(requests).toEqual([
        {
          method: 'POST',
          body: {
            projectRepositoryId: 'mobile',
            path: 'ios/Config.xcconfig',
            stage: 'staging',
            content: 'API_URL = https://staging',
          },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const table = await screen.findByRole('table', { name: 'Env files of acme/mobile' });
    expect(await within(table).findByText('ios/Config.xcconfig')).toBeInTheDocument();
    expect(screen.queryByText('API_URL = https://staging')).not.toBeInTheDocument();
  });

  it('edits a stage without loading the content, and changes content only after Reveal', async () => {
    const requests = useEnvFilesServer([file('f1', 'web', '.env', 'development')]);
    const user = userEvent.setup();

    renderSettings();
    await openRepository(user, 'acme/web');
    await user.click(await screen.findByRole('button', { name: '.env actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('.env content hidden')).toHaveTextContent('••••••••••••');
    expect(within(dialog).queryByRole('textbox', { name: 'Content' })).not.toBeInTheDocument();
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Stage' })).getByRole('radio', { name: 'Staging' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests).toEqual([{ method: 'PATCH', id: 'f1', body: { stage: 'staging' } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(await screen.findByRole('button', { name: '.env actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reveal' }));
    const content = await within(dialog).findByRole('textbox', { name: 'Content' });
    expect(content).toHaveValue(SECRET);
    await user.clear(content);
    await user.type(content, 'API_KEY=rotated');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests.slice(1)).toEqual([
        { method: 'GET', id: 'f1', body: null },
        { method: 'PATCH', id: 'f1', body: { content: 'API_KEY=rotated' } },
      ]),
    );
  });

  it('deletes after confirmation', async () => {
    const requests = useEnvFilesServer([file('f1', 'web', '.env', 'development')]);
    const user = userEvent.setup();

    renderSettings();
    await openRepository(user, 'acme/web');
    await user.click(await screen.findByRole('button', { name: '.env actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(requests).toEqual([{ method: 'DELETE', id: 'f1', body: null }]));
    await waitFor(() => expect(screen.queryByText('.env')).not.toBeInTheDocument());
  });

  it('shows a member paths and stages only, with no way to add, reveal or change', async () => {
    const requests = useEnvFilesServer([file('f1', 'web', '.env', 'development')], { canManage: false });
    const user = userEvent.setup();

    renderSettings();
    await openRepository(user, 'acme/web');

    const table = await screen.findByRole('table', { name: 'Env files of acme/web' });
    expect(within(table).getByText('.env')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: '.env actions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add env file to acme/web' })).toBeDisabled();
    expect(screen.getByText('Only organization admins can add, view or change env files.')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('envFilePathProblem', () => {
  it('accepts paths inside the repository and names why others are refused', () => {
    for (const path of ['.env', '.env.staging', 'apps/mobile/.env', 'ios/Config.xcconfig']) {
      expect(envFilePathProblem(path), path).toBeUndefined();
    }
    expect(envFilePathProblem('')).toBe('empty');
    expect(envFilePathProblem('/etc/x')).toBe('absolute');
    expect(envFilePathProblem('a/../../b')).toBe('parent');
    expect(envFilePathProblem('a//b')).toBe('segments');
    expect(envFilePathProblem('.git/config')).toBe('git');
    expect(envFilePathProblem('my env')).toBe('chars');
  });
});
