import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { SandboxEnv, SandboxEnvList } from '../../../workspaces/services/sandbox-envs';
import { EnvironmentSection } from '../EnvironmentSection';
import { environmentPayload, FACTORY_ID } from './fixtures/environment';

const ENVS_URL = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sandbox-envs`;

interface RecordedRequest {
  method: string;
  name: string;
  body: unknown;
}

function env(name: string, appliesTo: SandboxEnv['appliesTo'], stage: SandboxEnv['stage'] = 'development'): SandboxEnv {
  return { name, appliesTo, stage, updatedAt: '2026-11-09T12:00:00.000Z', updatedBy: 'user-1' };
}

/** A tiny in-memory server for the routes; values are kept but never returned, like the real one. */
function useSandboxEnvsServer(
  initial: SandboxEnv[],
  writable = true,
  options: { canManage?: boolean; stages?: SandboxEnvList['stages']; failing?: Set<string> } = {},
) {
  const envs = new Map(initial.map(item => [item.name, item]));
  const requests: RecordedRequest[] = [];
  let stages = options.stages ?? ['development'];
  const list = (): SandboxEnvList => ({
    envs: [...envs.values()],
    writable,
    stages,
    canManage: options.canManage ?? true,
  });
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/environment`, () =>
      HttpResponse.json({ environment: environmentPayload() }),
    ),
    http.get(ENVS_URL, () => HttpResponse.json(list())),
    http.put<never, { stages: SandboxEnvList['stages'] }>(
      `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sandbox-stages`,
      async ({ request }) => {
        const body = await request.json();
        requests.push({ method: 'PUT', name: 'sandbox-stages', body });
        stages = body.stages;
        return HttpResponse.json({ stages });
      },
    ),
    http.put<{ name: string }, { value: string; appliesTo: SandboxEnv['appliesTo']; stage?: SandboxEnv['stage'] }>(
      `${ENVS_URL}/:name`,
      async ({ params, request }) => {
        const body = await request.json();
        requests.push({ method: 'PUT', name: params.name, body });
        if (options.failing?.has(params.name)) {
          return HttpResponse.json({ message: 'Value refused by the server' }, { status: 400 });
        }
        const saved = env(params.name, body.appliesTo, body.stage ?? envs.get(params.name)?.stage);
        envs.set(params.name, saved);
        return HttpResponse.json({ env: saved });
      },
    ),
    http.patch<{ name: string }, { appliesTo?: SandboxEnv['appliesTo']; stage?: SandboxEnv['stage'] }>(
      `${ENVS_URL}/:name`,
      async ({ params, request }) => {
        const body = await request.json();
        requests.push({ method: 'PATCH', name: params.name, body });
        const current = envs.get(params.name)!;
        const saved = env(params.name, body.appliesTo ?? current.appliesTo, body.stage ?? current.stage);
        envs.set(params.name, saved);
        return HttpResponse.json({ env: saved });
      },
    ),
    http.delete<{ name: string }>(`${ENVS_URL}/:name`, ({ params }) => {
      requests.push({ method: 'DELETE', name: params.name, body: null });
      envs.delete(params.name);
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

async function section() {
  const heading = await screen.findByRole('heading', { name: 'Environment variables' });
  return within(heading.closest('section')!);
}

type User = ReturnType<typeof userEvent.setup>;

async function openRowAction(user: User, vars: Awaited<ReturnType<typeof section>>, name: string, action: string) {
  await user.click(await vars.findByRole('button', { name: `${name} actions` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('Environment variables settings', () => {
  it('sits between Configuration and Builds and lists variables in a table with masked values', async () => {
    useSandboxEnvsServer([env('DATABASE_URL', 'runtime'), env('NPM_TOKEN', 'both')]);

    renderSettings();

    const vars = await section();
    const table = await vars.findByRole('table', { name: 'Environment variables' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(header => header.textContent);
    expect(headers).toEqual(['Name', 'Value', 'Applies to', 'Stage', 'Updated', 'Actions']);
    expect(within(table).getByRole('button', { name: 'About where variables apply' })).toHaveAccessibleDescription(
      /Runtime: every command in the sandbox.*Build: only the template image build/,
    );
    expect(within(table).getByText('DATABASE_URL')).toBeInTheDocument();
    expect(within(table).getByLabelText('DATABASE_URL value hidden')).toHaveTextContent('••••••••••••');
    expect(within(table).getByLabelText('NPM_TOKEN applies to')).toHaveTextContent('BuildRuntime');
    expect(within(table).getByLabelText('DATABASE_URL applies to')).toHaveTextContent('Runtime');
    expect(vars.queryByRole('button', { name: /reveal|show/i })).not.toBeInTheDocument();
    // The add form only opens from the header button.
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    const headings = screen.getAllByRole('heading').map(heading => heading.textContent);
    expect(headings).toEqual(['Repositories', 'Configuration', 'Environment variables', 'Builds']);
  });

  it('shows an empty state when there are no variables', async () => {
    useSandboxEnvsServer([]);

    renderSettings();

    const vars = await section();
    expect(await vars.findByText('No variables yet.')).toBeInTheDocument();
    expect(vars.queryByRole('table')).not.toBeInTheDocument();
  });

  it('adds a variable from the form after a review that masks its value', async () => {
    const requests = useSandboxEnvsServer([]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await user.click(await vars.findByRole('button', { name: 'Add or import' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'true');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'API_KEY');
    const valueInput = within(dialog).getByRole('textbox', { name: 'Value' });
    await user.type(valueInput, 'sk-123');
    // A textbox, not a password field: what you type is visible until it's reviewed.
    expect(valueInput).toHaveValue('sk-123');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Build' }));
    await user.click(within(dialog).getByRole('button', { name: 'Review variables' }));

    const table = await within(dialog).findByRole('table', { name: 'Variables to import' });
    expect(within(table).getByText('API_KEY')).toBeInTheDocument();
    expect(within(table).getByText('••••••••••••')).toBeInTheDocument();
    expect(within(table).getByLabelText('API_KEY (line 1) status')).toHaveTextContent('New');
    expect(screen.queryByText('sk-123')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Save 1 variable' }));

    await waitFor(() =>
      expect(requests).toEqual([
        { method: 'PUT', name: 'API_KEY', body: { value: 'sk-123', appliesTo: 'both', stage: 'development' } },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await vars.findByLabelText('API_KEY value hidden')).toHaveTextContent('••••••••••••');
  });

  it('flags a name that already exists as an overwrite and asks for at least one target', async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await vars.findByText('API_KEY');
    await user.click(vars.getByRole('button', { name: 'Add or import' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'API_KEY');
    await user.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'rotated');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Runtime' }));
    expect(within(dialog).getByText('Pick at least one.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Review variables' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Runtime' }));
    await user.click(within(dialog).getByRole('button', { name: 'Review variables' }));

    expect(await within(dialog).findByLabelText('API_KEY (line 1) status')).toHaveTextContent('Overwrites existing');
    await user.click(within(dialog).getByRole('button', { name: 'Save 1 variable' }));
    await waitFor(() =>
      expect(requests).toEqual([
        { method: 'PUT', name: 'API_KEY', body: { value: 'rotated', appliesTo: 'runtime', stage: 'development' } },
      ]),
    );
  });

  it('changes where a variable applies from Edit with PATCH and no value', async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await openRowAction(user, vars, 'API_KEY', 'Edit');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'Value' })).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Build' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Runtime' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(requests).toEqual([{ method: 'PATCH', name: 'API_KEY', body: { appliesTo: 'build' } }]));
    await waitFor(() => expect(vars.getByLabelText('API_KEY applies to')).toHaveTextContent(/^Build$/));
  });

  it('sends a new value and where it applies together with PUT, then masks it again', async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await openRowAction(user, vars, 'API_KEY', 'Edit');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'rotated');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Build' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(requests).toEqual([{ method: 'PUT', name: 'API_KEY', body: { value: 'rotated', appliesTo: 'both' } }]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(vars.getByLabelText('API_KEY value hidden')).toHaveTextContent('••••••••••••');
    expect(screen.queryByText('rotated')).not.toBeInTheDocument();
  });

  it('cancels an edit without sending anything', async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await openRowAction(user, vars, 'API_KEY', 'Edit');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'draft');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(requests).toEqual([]);
  });

  it('deletes after confirmation', async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    await openRowAction(user, vars, 'API_KEY', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    expect(requests).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(requests).toEqual([{ method: 'DELETE', name: 'API_KEY', body: null }]));
    await waitFor(() => expect(vars.queryByText('API_KEY')).not.toBeInTheDocument());
  });

  it('explains and disables saving when the server has no encryption key', async () => {
    useSandboxEnvsServer([env('API_KEY', 'runtime')], false);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    expect(await vars.findByText(/can't be saved until a credential encryption key is configured/)).toBeInTheDocument();
    expect(vars.getByRole('button', { name: 'Add or import' })).toBeDisabled();
    await user.click(vars.getByRole('button', { name: 'API_KEY actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
    // Delete still works so old values can be removed.
    expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it("shows each variable's stage and moves one to staging with PATCH", async () => {
    const requests = useSandboxEnvsServer([env('API_KEY', 'runtime'), env('PROD_KEY', 'runtime', 'production')]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    expect(await vars.findByLabelText('API_KEY stage')).toHaveTextContent('Development');
    expect(vars.getByLabelText('PROD_KEY stage')).toHaveTextContent('Production');
    await openRowAction(user, vars, 'API_KEY', 'Edit');
    const dialog = await screen.findByRole('dialog');
    const stage = within(dialog).getByRole('radiogroup', { name: 'Stage' });
    expect(within(stage).getByRole('radio', { name: 'Development' })).toBeChecked();
    await user.click(within(stage).getByRole('radio', { name: 'Production' }));
    expect(within(dialog).getByText(/Production never reaches agent sandboxes/)).toBeInTheDocument();
    await user.click(within(stage).getByRole('radio', { name: 'Staging' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(requests).toEqual([{ method: 'PATCH', name: 'API_KEY', body: { stage: 'staging' } }]));
    await waitFor(() => expect(vars.getByLabelText('API_KEY stage')).toHaveTextContent('Staging'));
  });

  it('lets an admin give sandboxes staging, and says production never reaches them', async () => {
    const requests = useSandboxEnvsServer([]);
    const user = userEvent.setup();

    renderSettings();

    const vars = await section();
    const toggle = await vars.findByRole('switch', { name: 'Staging in sandboxes' });
    expect(toggle).not.toBeChecked();
    expect(vars.getByText(/Production never reaches agent sandboxes/)).toBeInTheDocument();
    await user.click(toggle);

    await waitFor(() =>
      expect(requests).toEqual([{ method: 'PUT', name: 'sandbox-stages', body: { stages: ['development', 'staging'] } }]),
    );
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    await waitFor(() =>
      expect(requests.at(-1)).toEqual({ method: 'PUT', name: 'sandbox-stages', body: { stages: ['development'] } }),
    );
  });

  it("shows a member the stages but doesn't let them change them", async () => {
    const requests = useSandboxEnvsServer([], true, { canManage: false, stages: ['development', 'staging'] });

    renderSettings();

    const vars = await section();
    const toggle = await vars.findByRole('switch', { name: 'Staging in sandboxes' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(vars.getByText('Only organization admins can change this.')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

const RAW_ENV = [
  '# Acme staging',
  'export API_KEY=sk-secret-1',
  'DATABASE_URL="postgres://user:pa=ss@host:5432/db" # primary',
  'PRIVATE_KEY="-----BEGIN KEY-----',
  'MIIsecret',
  '-----END KEY-----"',
  'EMPTY=',
  'not a line',
  'API_KEY=sk-secret-2',
  'GH_TOKEN=nope',
].join('\n');

async function openImport(user: User) {
  const vars = await section();
  await user.click(await vars.findByRole('button', { name: 'Add or import' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('tab', { name: 'Raw' }));
  return dialog;
}

describe('Importing environment variables', () => {
  it('parses pasted .env text, shows what it could not read and saves the rest to the chosen stage', async () => {
    const requests = useSandboxEnvsServer([env('DATABASE_URL', 'runtime')]);
    const user = userEvent.setup();

    renderSettings();

    const dialog = await openImport(user);
    await user.click(within(dialog).getByRole('textbox', { name: 'Raw .env' }));
    await user.paste(RAW_ENV);
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Apply to stage' })).getByRole('radio', { name: 'Staging' }));
    await user.click(within(dialog).getByRole('button', { name: 'Review variables' }));

    const problems = await within(dialog).findByRole('list', { name: "Lines that can't be imported" });
    expect(within(problems).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Line 8: not a KEY=value line',
    ]);
    expect(within(dialog).getByText("1 line can't be imported")).toBeInTheDocument();
    const table = within(dialog).getByRole('table', { name: 'Variables to import' });
    expect(within(table).getByLabelText('API_KEY (line 2) status')).toHaveTextContent('Duplicate: line 9 wins');
    expect(within(table).getByLabelText('API_KEY (line 9) status')).toHaveTextContent('New');
    expect(within(table).getByLabelText('DATABASE_URL (line 3) status')).toHaveTextContent('Overwrites existing');
    expect(within(table).getByLabelText('GH_TOKEN (line 10) status')).toHaveTextContent('Name reserved by Factory');
    expect(within(table).getByText('empty')).toBeInTheDocument();
    expect(screen.queryByText(/sk-secret|MIIsecret|pa=ss/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/4 variables will be saved to Staging \(Runtime\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save 4 variables' }));

    await waitFor(() =>
      expect(requests).toEqual([
        { method: 'PUT', name: 'DATABASE_URL', body: { value: 'postgres://user:pa=ss@host:5432/db', appliesTo: 'runtime', stage: 'staging' } },
        {
          method: 'PUT',
          name: 'PRIVATE_KEY',
          body: { value: '-----BEGIN KEY-----\nMIIsecret\n-----END KEY-----', appliesTo: 'runtime', stage: 'staging' },
        },
        { method: 'PUT', name: 'EMPTY', body: { value: '', appliesTo: 'runtime', stage: 'staging' } },
        { method: 'PUT', name: 'API_KEY', body: { value: 'sk-secret-2', appliesTo: 'runtime', stage: 'staging' } },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Saved 4 variables')).toBeInTheDocument();
  });

  it('fills the text from a dropped .env file', async () => {
    useSandboxEnvsServer([]);
    const user = userEvent.setup();

    renderSettings();

    const dialog = await openImport(user);
    const zone = within(dialog).getByRole('group', { name: 'Drop a .env file here' });
    const dropped = new File(['A=1\nB=2\n'], '.env', { type: 'text/plain' });
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [dropped] } });

    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Raw .env' })).toHaveValue('A=1\nB=2\n'));
  });

  it('fills the text from a chosen file and refuses one that is too large', async () => {
    useSandboxEnvsServer([]);
    const user = userEvent.setup();

    renderSettings();

    const dialog = await openImport(user);
    const input = within(dialog).getByLabelText('Choose file');
    await user.upload(input, new File(['TOKEN=abc'], '.env.local', { type: 'text/plain' }));
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Raw .env' })).toHaveValue('TOKEN=abc'));

    await user.upload(input, new File(['x'.repeat(600 * 1024)], 'huge.env', { type: 'text/plain' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('huge.env is too large: at most 256 KB.');
    expect(within(dialog).getByRole('textbox', { name: 'Raw .env' })).toHaveValue('TOKEN=abc');
  });

  it('keeps the dialog open after a partial failure, shows each result and retries only the failed one', async () => {
    const failing = new Set(['BROKEN']);
    const requests = useSandboxEnvsServer([], true, { failing });
    const user = userEvent.setup();

    renderSettings();

    const dialog = await openImport(user);
    await user.click(within(dialog).getByRole('textbox', { name: 'Raw .env' }));
    await user.paste('GOOD=1\nBROKEN=2');
    await user.click(within(dialog).getByRole('button', { name: 'Review variables' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save 2 variables' }));

    expect(await within(dialog).findByText('Saved 1 of 2; 1 failed. The saved ones stay saved: retry the failed ones or cancel.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('GOOD (line 1) status')).toHaveTextContent('Saved');
    expect(within(dialog).getByLabelText('BROKEN (line 2) status')).toHaveTextContent('Failed: Value refused by the server');
    expect(requests.map(request => request.name)).toEqual(['GOOD', 'BROKEN']);

    failing.clear();
    await user.click(within(dialog).getByRole('button', { name: 'Retry 1 failed' }));
    await waitFor(() => expect(requests.map(request => request.name)).toEqual(['GOOD', 'BROKEN', 'BROKEN']));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
