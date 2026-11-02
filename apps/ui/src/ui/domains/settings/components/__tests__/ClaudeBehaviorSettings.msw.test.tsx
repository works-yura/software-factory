import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import { ClaudeBehaviorSettings } from '../ClaudeBehaviorSettings';

const PROJECT_URL = `${TEST_BASE_URL}/web/factory/projects/fp-1`;

/** A Claude Code Factory whose permissions the server keeps; PATCH bodies land in `patches`. */
function serveFactory(stored: unknown = null) {
  const patches: Array<Record<string, unknown>> = [];
  let toolPermissions = stored;
  server.use(
    http.get(PROJECT_URL, () =>
      HttpResponse.json({ project: { id: 'fp-1', name: 'Acme', harness: 'claude-code', toolPermissions } }),
    ),
    http.patch(PROJECT_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      toolPermissions = body.toolPermissions;
      return HttpResponse.json({
        project: { id: 'fp-1', name: 'Acme', harness: 'claude-code', toolPermissions },
      });
    }),
  );
  return patches;
}

describe('ClaudeBehaviorSettings', () => {
  it('lets auto-approve and the tool permissions be changed on a Factory that has no agent session', async () => {
    const patches = serveFactory();
    const user = userEvent.setup();
    renderWithProviders(<ClaudeBehaviorSettings factoryId="fp-1" />);

    const autoApprove = await screen.findByRole('switch', { name: 'Auto-approve tools' });
    await waitFor(() => expect(autoApprove).toBeEnabled());
    await user.click(autoApprove);
    await waitFor(() => expect(patches).toEqual([{ toolPermissions: { categories: {}, yolo: true } }]));

    // Auto-approve allows everything, so the per-category choices step aside.
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: /Read permission/ })).not.toBeInTheDocument());

    await user.click(autoApprove);
    const read = await screen.findByRole('radiogroup', { name: /Read permission/ });
    await user.click(within(read).getByRole('radio', { name: 'Allow' }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({ toolPermissions: { categories: { read: 'allow' }, yolo: false } }),
    );
  });

  it('shows what is stored and leaves out the Mastra-only rows', async () => {
    serveFactory({ categories: { execute: 'deny' }, yolo: false });
    renderWithProviders(<ClaudeBehaviorSettings factoryId="fp-1" />);

    const execute = await screen.findByRole('radiogroup', { name: /Execute permission/ });
    await waitFor(() => expect(within(execute).getByRole('radio', { name: 'Deny' })).toBeChecked());
    expect(screen.queryByText('Smart editing')).not.toBeInTheDocument();
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });
});
