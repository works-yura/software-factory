import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { AddApiKeyDialog } from '../AddApiKeyDialog';

const PROVIDERS_URL = `${TEST_BASE_URL}/web/config/providers`;

describe('AddApiKeyDialog', () => {
  it('saves an organization key without offering a personal scope', async () => {
    const saved: unknown[] = [];
    server.use(
      http.get(PROVIDERS_URL, () => HttpResponse.json({ orgKeyAdmin: false, providers: [] })),
      http.put(`${PROVIDERS_URL}/:provider/key`, async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AddApiKeyDialog
        provider={{ provider: 'openai', source: 'none' }}
        authEnabled
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Everyone in your organization can use this key/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Just me' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Paste API key'), 'sk-org');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toEqual([{ key: 'sk-org', scope: 'org' }]));
  });
});
