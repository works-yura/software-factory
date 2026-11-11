import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { FirebaseAccount, FirebaseBinding, FirebaseState } from '../../services/firebase';
import { GoogleCloudService } from '../GoogleCloudService';

const BASE = `${TEST_BASE_URL}/web/firebase`;
const FACTORIES_URL = `${TEST_BASE_URL}/web/factory/projects`;

const synctaAccount: FirebaseAccount = {
  id: 'acc-syncta',
  name: 'Syncta',
  clientEmail: 'factory@syncta-57c6a.iam.gserviceaccount.com',
  projectId: 'syncta-57c6a',
  keyId: 'k1',
  bindingIds: [],
};
const bookfateAccount: FirebaseAccount = {
  id: 'acc-bookfate',
  name: 'BookFate',
  clientEmail: 'factory@bookfate-prod.iam.gserviceaccount.com',
  projectId: 'bookfate-prod',
  keyId: 'k2',
  bindingIds: [],
};
const synctaBinding: FirebaseBinding = {
  id: 'bnd-1',
  factoryProjectId: 'factory-1',
  accountId: 'acc-syncta',
  projectId: 'syncta-57c6a',
  projectNumber: '650392591794',
  logs: true,
  crashes: false,
  apps: [],
};

type Write = { method: string; url: string; body: unknown };

/** A fake server keeping the state the page shows; every write answers with the whole state. */
function useHandlers(initial: { accounts?: FirebaseAccount[]; bindings?: FirebaseBinding[] } = {}) {
  const writes: Write[] = [];
  let state: FirebaseState = { accounts: initial.accounts ?? [], bindings: initial.bindings ?? [] };
  const withUsage = (): FirebaseState => ({
    ...state,
    accounts: state.accounts.map(account => ({
      ...account,
      bindingIds: state.bindings.filter(binding => binding.accountId === account.id).map(binding => binding.id),
    })),
  });
  const record = async (method: string, request: Request) => {
    const body = method === 'DELETE' ? undefined : await request.json();
    writes.push({ method, url: request.url, body });
    return body as Record<string, any>;
  };
  server.use(
    http.get(`${BASE}/status`, () => HttpResponse.json(withUsage())),
    http.get(FACTORIES_URL, () =>
      HttpResponse.json({
        projects: [
          { id: 'factory-1', name: 'syncts', repositories: [] },
          { id: 'factory-2', name: 'book-fate', repositories: [] },
        ],
      }),
    ),
    http.post(`${BASE}/accounts`, async ({ request }) => {
      const body = await record('POST', request);
      const account = { ...bookfateAccount, ...(body.name ? { name: body.name } : {}) };
      state = { ...state, accounts: [...state.accounts, account] };
      return HttpResponse.json({ account, ...withUsage() });
    }),
    http.delete(`${BASE}/accounts/:accountId`, async ({ request, params }) => {
      await record('DELETE', request);
      const used = state.bindings.filter(binding => binding.accountId === params.accountId);
      if (used.length > 0 && !new URL(request.url).searchParams.get('withBindings')) {
        return HttpResponse.json({ error: 'account_in_use', message: 'in use' }, { status: 409 });
      }
      state = {
        accounts: state.accounts.filter(account => account.id !== params.accountId),
        bindings: state.bindings.filter(binding => binding.accountId !== params.accountId),
      };
      return HttpResponse.json(withUsage());
    }),
    http.post(`${BASE}/bindings/check`, async ({ request }) => {
      await record('POST', request);
      return HttpResponse.json({
        ok: false,
        checks: [
          { check: 'logs', target: 'syncta-57c6a', ok: true },
          {
            check: 'crashes',
            target: '1:650392591794:android:abc123',
            ok: false,
            message: 'Crashlytics refused the service account',
            missingRole: 'roles/firebasecrashlytics.viewer',
            fix: 'Grant roles/firebasecrashlytics.viewer to the service account on project syncta-57c6a.',
          },
        ],
      });
    }),
    http.post(`${BASE}/bindings`, async ({ request }) => {
      const body = await record('POST', request);
      const binding = { id: `bnd-${state.bindings.length + 2}`, ...body } as FirebaseBinding;
      state = { ...state, bindings: [...state.bindings, binding] };
      return HttpResponse.json({ binding, ...withUsage() });
    }),
    // What each account sees: BookFate's account also sees a staging project; Syncta's databases list two.
    http.get(`${BASE}/accounts/:accountId/projects`, ({ params }) =>
      HttpResponse.json(
        params.accountId === 'acc-bookfate'
          ? { items: [{ value: 'bookfate-prod' }, { value: 'bookfate-staging', label: 'BookFate Staging' }], default: 'bookfate-prod' }
          : { items: [{ value: 'syncta-57c6a' }], default: 'syncta-57c6a', denied: { role: 'roles/datastore.viewer', message: 'refused' } },
      ),
    ),
    http.get(`${BASE}/accounts/:accountId/databases`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get('project') === 'syncta-57c6a'
          ? { items: [{ value: '(default)' }, { value: 'analytics', detail: 'eur3' }], default: '(default)' }
          : { items: [{ value: '(default)' }], default: '(default)' },
      ),
    ),
    http.put(`${BASE}/bindings/:bindingId`, async ({ request, params }) => {
      const body = await record('PUT', request);
      state = { ...state, bindings: state.bindings.map(binding => (binding.id === params.bindingId ? ({ id: binding.id, ...body } as FirebaseBinding) : binding)) };
      return HttpResponse.json(withUsage());
    }),
  );
  return writes;
}

function renderSection() {
  return renderWithProviders(
    <>
      <GoogleCloudService />
      <Toaster />
    </>,
  );
}

describe('GoogleCloudService', () => {
  it('adds a named account through the key dialog and shows whose key it is, never the key', async () => {
    const writes = useHandlers({ accounts: [synctaAccount] });
    renderSection();

    expect(await screen.findByRole('button', { name: /^Syncta\s*factory@syncta-57c6a\.iam\.gserviceaccount\.com · not used$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Google Cloud account' });
    await userEvent.type(within(dialog).getByLabelText('Account name'), 'BookFate');
    await userEvent.click(within(dialog).getByLabelText('Service account key JSON'));
    await userEvent.paste('{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----x"}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(writes[0]).toMatchObject({ method: 'POST', url: `${BASE}/accounts`, body: { name: 'BookFate' } }));
    expect((writes[0]!.body as { serviceAccountJson: string }).serviceAccountJson).toContain('service_account');
    expect(await screen.findByRole('button', { name: /^BookFate\s*factory@bookfate-prod/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('BEGIN PRIVATE KEY');
  });

  it('lists bindings collapsed as Factory → Google Cloud project with the account and what is read', async () => {
    useHandlers({
      accounts: [synctaAccount, bookfateAccount],
      bindings: [
        synctaBinding,
        {
          ...synctaBinding,
          id: 'bnd-2',
          factoryProjectId: 'factory-1',
          accountId: 'acc-bookfate',
          projectId: 'bookfate-prod',
          logs: false,
          crashes: true,
          apps: [
            { appId: '1:900351719125:android:65f1', platform: 'android' },
            { appId: '1:900351719125:ios:d2ef', platform: 'ios' },
          ],
        },
      ],
    });
    renderSection();

    expect(await screen.findByRole('button', { name: /^syncts → syncta-57c6a\s*Syncta · logs$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^syncts → bookfate-prod\s*BookFate · 2 apps$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Syncta\s*.* · 1 binding$/ })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Google Cloud project ID' })).not.toBeInTheDocument();
  });

  it('adds a binding: picks the Factory and account, proposes the key’s Google Cloud project, saves', async () => {
    const writes = useHandlers({ accounts: [synctaAccount, bookfateAccount] });
    renderSection();

    expect(await screen.findByText(/No Factory reads logs or crashes yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Factory' }));
    await userEvent.click(await screen.findByRole('option', { name: 'book-fate' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Google Cloud account' }));
    await userEvent.click(await screen.findByRole('option', { name: 'BookFate' }));
    const project = screen.getByRole('combobox', { name: 'Google Cloud project ID' });
    await waitFor(() => expect(project).toHaveValue('bookfate-prod'));
    await userEvent.click(project);
    expect(await screen.findByRole('option', { name: /BookFate Staging \(bookfate-staging\)/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByLabelText('Google Cloud project number'), '900351719125');
    await userEvent.click(screen.getByRole('switch', { name: 'App crashes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await userEvent.type(screen.getByLabelText('Firebase App ID 1'), '1:900351719125:android:65f109e838d2590e1a545c');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writes.find(write => write.method === 'POST' && write.url === `${BASE}/bindings`)?.body).toEqual({
        factoryProjectId: 'factory-2',
        accountId: 'acc-bookfate',
        projectId: 'bookfate-prod',
        projectNumber: '900351719125',
        logs: true,
        crashes: true,
        database: { enabled: false },
        apps: [{ appId: '1:900351719125:android:65f109e838d2590e1a545c', platform: 'android' }],
      }),
    );
    expect(await screen.findByRole('button', { name: /^book-fate → bookfate-prod\s*BookFate · logs · 1 app$/ })).toBeInTheDocument();
  });

  it('checks a binding inline and names the role that is missing', async () => {
    const writes = useHandlers({ accounts: [synctaAccount], bindings: [synctaBinding] });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts → syncta-57c6a/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check access' }));
    const results = await screen.findByRole('list', { name: 'Check results' });
    expect(within(results).getByText('Logs of Google Cloud project syncta-57c6a')).toBeInTheDocument();
    expect(within(results).getByText(/Missing role roles\/firebasecrashlytics\.viewer\./)).toBeInTheDocument();
    expect(writes.at(-1)?.body).toMatchObject({ binding: { accountId: 'acc-syncta', projectId: 'syncta-57c6a', factoryProjectId: 'factory-1' } });
  });

  it('disconnecting an account its bindings use asks first, then removes both', async () => {
    const writes = useHandlers({ accounts: [synctaAccount], bindings: [synctaBinding] });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^Syncta\s*factory@syncta/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect account Syncta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect «Syncta»?' });
    expect(within(within(dialog).getByRole('list', { name: 'Bindings removed with the account' })).getByText('syncts → syncta-57c6a')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect with its bindings' }));

    await waitFor(() => expect(writes[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/accounts/acc-syncta?withBindings=true` }));
    expect(await screen.findByText(/No account yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^syncts → syncta-57c6a/ })).not.toBeInTheDocument();
  });

  it('disconnects an unused account without asking, and no binding can be added without an account', async () => {
    const writes = useHandlers({ accounts: [synctaAccount] });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^Syncta\s*factory@syncta/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect account Syncta' }));
    await waitFor(() => expect(writes[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/accounts/acc-syncta` }));
    expect(await screen.findByText('Add a Google Cloud account first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add binding' })).toBeDisabled();
  });

  it('switches «База» on for a binding: the project\'s Firestore, with its database id, and the summary says so', async () => {
    const writes = useHandlers({ accounts: [synctaAccount], bindings: [synctaBinding] });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts → / }));
    await userEvent.click(screen.getByRole('switch', { name: 'Database (Firestore)' }));
    const database = screen.getByRole('combobox', { name: 'Firestore database' });
    await waitFor(() => expect(database).toHaveValue('(default)'));
    await userEvent.clear(database);
    await userEvent.type(database, 'analyt');
    await userEvent.click(await screen.findByRole('option', { name: /^analytics/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writes.find(write => write.method === 'PUT')?.body).toMatchObject({ database: { enabled: true, databaseId: 'analytics' } }),
    );
    expect(await screen.findByRole('button', { name: /· database/ })).toBeInTheDocument();
  });

  it('still offers the key’s own project when the account may not list projects, naming the role to grant', async () => {
    useHandlers({ accounts: [synctaAccount], bindings: [synctaBinding] });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts → / }));
    expect(await screen.findByText(/grant it roles\/datastore\.viewer/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Google Cloud project ID' })).toHaveValue('syncta-57c6a');
  });
});
