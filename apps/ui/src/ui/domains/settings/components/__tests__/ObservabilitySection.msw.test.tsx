import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { ObservabilitySection } from '../ObservabilitySection';

const STATUS_URL = `${TEST_BASE_URL}/web/firebase/status`;
const CONNECTION_URL = `${TEST_BASE_URL}/web/firebase/connection`;
const MAPPINGS_URL = `${TEST_BASE_URL}/web/firebase/factories`;
const MAPPING_URL = `${TEST_BASE_URL}/web/firebase/factories/factory-1`;
const CHECK_URL = `${TEST_BASE_URL}/web/firebase/factories/factory-1/check`;
const FACTORIES_URL = `${TEST_BASE_URL}/web/factory/projects`;

const account = { clientEmail: 'reader@syncta-prod.iam.gserviceaccount.com', projectId: 'syncta-prod', keyId: 'k1' };
const syncta = {
  projectId: 'syncta-prod',
  projectNumber: '1234567890',
  logs: true,
  apps: [
    { appId: '1:1234567890:android:abc123', platform: 'android' },
    { appId: '1:1234567890:ios:def456', platform: 'ios' },
  ],
};

function useHandlers({ connected = false, mappings = {} as Record<string, unknown> } = {}) {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  let status: { connected: boolean; account?: typeof account } = connected ? { connected: true, account } : { connected: false };
  server.use(
    http.get(STATUS_URL, () => HttpResponse.json(status)),
    http.get(FACTORIES_URL, () =>
      HttpResponse.json({
        projects: [
          { id: 'factory-1', name: 'syncts', repositories: [] },
          { id: 'factory-2', name: 'post-airborne', repositories: [] },
        ],
      }),
    ),
    http.put(CONNECTION_URL, async ({ request }) => {
      writes.push({ method: 'PUT', url: CONNECTION_URL, body: await request.json() });
      status = { connected: true, account };
      return HttpResponse.json(status);
    }),
    http.get(MAPPINGS_URL, () => HttpResponse.json({ mappings })),
    http.put(MAPPING_URL, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'PUT', url: MAPPING_URL, body });
      return HttpResponse.json({ mapping: body });
    }),
    http.post(CHECK_URL, async ({ request }) => {
      writes.push({ method: 'POST', url: CHECK_URL, body: await request.json() });
      return HttpResponse.json({
        ok: false,
        checks: [
          { check: 'logs', target: 'syncta-prod', ok: true },
          {
            check: 'crashes',
            target: '1:1234567890:android:abc123',
            ok: false,
            message: 'Crashlytics refused the service account',
            missingRole: 'roles/firebasecrashlytics.viewer',
            fix: 'Grant roles/firebasecrashlytics.viewer to the service account on project syncta-prod.',
          },
        ],
      });
    }),
  );
  return writes;
}

function renderSection() {
  return renderWithProviders(
    <>
      <ObservabilitySection />
      <Toaster />
    </>,
  );
}

describe('ObservabilitySection', () => {
  it('connects through a key dialog, then shows only whose key it is', async () => {
    const writes = useHandlers();
    renderSection();

    expect(await screen.findByText(/Needs a Google Cloud service account key/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Firebase service account key' });
    await userEvent.click(within(dialog).getByLabelText('Service account key JSON'));
    await userEvent.paste('{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----x"}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(writes[0]).toMatchObject({ method: 'PUT', url: CONNECTION_URL }));
    expect((writes[0]!.body as { serviceAccountJson: string }).serviceAccountJson).toContain('service_account');
    expect(await screen.findByText(`Connected to ${account.clientEmail}`)).toBeInTheDocument();
    expect(screen.getByText(`${account.clientEmail} · project syncta-prod`)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('BEGIN PRIVATE KEY');
  });

  it('lists linked projects collapsed with what each reads', async () => {
    useHandlers({ connected: true, mappings: { 'factory-1': syncta, 'factory-2': { ...syncta, projectId: 'airborne-prod', crashes: false } } });
    renderSection();

    expect(await screen.findByRole('button', { name: /^syncts\s*project syncta-prod · logs · 2 apps$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^post-airborne\s*project airborne-prod · logs$/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Project ID')).not.toBeInTheDocument();
  });

  it('adds a project for a Factory and saves what it reads', async () => {
    const writes = useHandlers({ connected: true });
    renderSection();

    expect(await screen.findByText('No Factory is linked to a Firebase project yet.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Add project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'syncts' }));

    await userEvent.type(await screen.findByLabelText('Project ID'), 'syncta-prod');
    await userEvent.type(screen.getByLabelText('Project number'), '1234567890');
    await userEvent.click(screen.getByRole('button', { name: 'Add app' }));
    await userEvent.type(screen.getByLabelText('Firebase App ID 1'), '1:1234567890:android:abc123');
    await userEvent.type(screen.getByLabelText('Name of app 1'), 'Syncta Android');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(writes.find(write => write.url === MAPPING_URL)?.body).toEqual({
        projectId: 'syncta-prod',
        projectNumber: '1234567890',
        logs: true,
        crashes: true,
        apps: [{ appId: '1:1234567890:android:abc123', platform: 'android', label: 'Syncta Android' }],
      }),
    );
  });

  it('switching crashes off hides the apps and saves it', async () => {
    const writes = useHandlers({ connected: true, mappings: { 'factory-1': syncta } });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts\s*project/ }));
    expect(await screen.findByRole('region', { name: 'Apps (crashes)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'App crashes' }));
    expect(screen.queryByRole('region', { name: 'Apps (crashes)' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes.find(write => write.url === MAPPING_URL)?.body).toMatchObject({ crashes: false }));
  });

  it('checks access inline and names the role that is missing', async () => {
    useHandlers({ connected: true, mappings: { 'factory-1': syncta } });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts\s*project/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check access' }));
    const results = await screen.findByRole('list', { name: 'Check results' });
    expect(within(results).getByText('Logs of project syncta-prod')).toBeInTheDocument();
    expect(within(results).getByText(/Missing role roles\/firebasecrashlytics\.viewer\./)).toBeInTheDocument();
  });

  it('cannot check access before a key is saved', async () => {
    useHandlers({ mappings: { 'factory-1': { projectId: 'syncta-prod', logs: true, apps: [] } } });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /^syncts\s*project/ }));
    expect(await screen.findByRole('button', { name: 'Check access' })).toBeDisabled();
    expect(screen.getByText('Save the service account key first to check access.')).toBeInTheDocument();
  });
});
