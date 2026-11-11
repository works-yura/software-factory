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
const MAPPING_URL = `${TEST_BASE_URL}/web/firebase/factories/factory-1`;
const CHECK_URL = `${TEST_BASE_URL}/web/firebase/factories/factory-1/check`;

const account = { clientEmail: 'reader@syncta-prod.iam.gserviceaccount.com', projectId: 'syncta-prod', keyId: 'k1' };

function useHandlers({ connected = false, mapping = null as unknown } = {}) {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  let status: { connected: boolean; account?: typeof account } = connected ? { connected: true, account } : { connected: false };
  server.use(
    http.get(STATUS_URL, () => HttpResponse.json(status)),
    http.put(CONNECTION_URL, async ({ request }) => {
      const body = await request.json();
      writes.push({ method: 'PUT', url: CONNECTION_URL, body });
      status = { connected: true, account };
      return HttpResponse.json(status);
    }),
    http.get(MAPPING_URL, () => HttpResponse.json({ mapping })),
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
      <ObservabilitySection factoryId="factory-1" />
      <Toaster />
    </>,
  );
}

describe('ObservabilitySection', () => {
  it('uploads a pasted key, then shows only whose key it is', async () => {
    const writes = useHandlers();
    renderSection();

    const keyField = await screen.findByLabelText('Service account key JSON');
    await userEvent.click(keyField);
    await userEvent.paste('{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----x"}');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(writes[0]).toMatchObject({ method: 'PUT', url: CONNECTION_URL }));
    expect((writes[0]!.body as { serviceAccountJson: string }).serviceAccountJson).toContain('service_account');
    expect(await screen.findByText(`${account.clientEmail} · project syncta-prod`)).toBeInTheDocument();
    expect(screen.queryByLabelText('Service account key JSON')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('BEGIN PRIVATE KEY');
  });

  it('maps the Factory to a project and an app and saves it', async () => {
    const writes = useHandlers({ connected: true });
    renderSection();

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
        apps: [{ appId: '1:1234567890:android:abc123', platform: 'android', label: 'Syncta Android' }],
      }),
    );
  });

  it('checks access and names the role that is missing', async () => {
    useHandlers({
      connected: true,
      mapping: {
        projectId: 'syncta-prod',
        projectNumber: '1234567890',
        logs: true,
        apps: [{ appId: '1:1234567890:android:abc123', platform: 'android' }],
      },
    });
    renderSection();

    await waitFor(() => expect(screen.getByLabelText('Project ID')).toHaveValue('syncta-prod'));
    await userEvent.click(screen.getByRole('button', { name: 'Check access' }));
    const results = await screen.findByRole('list', { name: 'Check results' });
    expect(within(results).getByText('Logs of project syncta-prod')).toBeInTheDocument();
    expect(within(results).getByText(/Missing role roles\/firebasecrashlytics\.viewer\./)).toBeInTheDocument();
  });

  it('cannot check access before a key is saved', async () => {
    useHandlers({ mapping: { projectId: 'syncta-prod', logs: true, apps: [] } });
    renderSection();

    await waitFor(() => expect(screen.getByLabelText('Project ID')).toHaveValue('syncta-prod'));
    expect(screen.getByRole('button', { name: 'Check access' })).toBeDisabled();
    expect(screen.getByText('Save the service account key first to check access.')).toBeInTheDocument();
  });
});
