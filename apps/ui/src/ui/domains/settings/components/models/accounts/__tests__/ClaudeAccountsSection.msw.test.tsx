/**
 * The Claude Code accounts section lists the accounts Claude Code sessions
 * rotate through and lets members add, switch off, rename and remove them.
 * Drives the real hooks + api client through MSW.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { CredentialAccountInfo, CredentialAccountsResponse } from '../../../../../../../api/types';
import { server } from '../../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../../e2e/ui/render';
import { ClaudeAccountsSection, formatAccountTime } from '../ClaudeAccountsSection';

const ACCOUNTS_URL = `${TEST_BASE_URL}/web/config/providers/anthropic/accounts`;

function account(overrides: Partial<CredentialAccountInfo> & Pick<CredentialAccountInfo, 'id' | 'label'>) {
  return {
    kind: 'subscription',
    mine: true,
    priority: 0,
    status: 'active',
    hint: 'abcd',
    canManage: true,
    canReplaceSecret: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  } satisfies CredentialAccountInfo;
}

/** A stateful accounts store: GET reflects every write made through the stubs. */
function stubAccounts(initial: CredentialAccountInfo[], canAddOrgKeys = false) {
  let accounts = [...initial];
  const writes: Array<{ method: string; id?: string; body?: unknown }> = [];
  server.use(
    http.get(ACCOUNTS_URL, () => HttpResponse.json({ accounts, canAddOrgKeys } satisfies CredentialAccountsResponse)),
    http.post(ACCOUNTS_URL, async ({ request }) => {
      const body = (await request.json()) as { label: string; secret: string };
      writes.push({ method: 'POST', body });
      const created = account({ id: `acc-${accounts.length + 1}`, label: body.label, hint: body.secret.slice(-4) });
      accounts = [...accounts, created];
      return HttpResponse.json({ account: created }, { status: 201 });
    }),
    http.patch(`${ACCOUNTS_URL}/:id`, async ({ params, request }) => {
      const body = (await request.json()) as { disabled?: boolean; label?: string };
      writes.push({ method: 'PATCH', id: String(params.id), body });
      accounts = accounts.map(item =>
        item.id === params.id
          ? {
              ...item,
              ...(body.label ? { label: body.label } : {}),
              ...(body.disabled !== undefined ? { status: body.disabled ? 'disabled' : 'active' } : {}),
            }
          : item,
      );
      return HttpResponse.json({ account: accounts.find(item => item.id === params.id) });
    }),
    http.delete(`${ACCOUNTS_URL}/:id`, ({ params }) => {
      writes.push({ method: 'DELETE', id: String(params.id) });
      accounts = accounts.filter(item => item.id !== params.id);
      return HttpResponse.json({ ok: true });
    }),
  );
  return writes;
}

const row = (label: string) => screen.getByRole('listitem', { name: label });

async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
}

describe('ClaudeAccountsSection', () => {
  it('lists each account with its kind, hint, status, last error and last use', async () => {
    const limitedUntil = '2026-10-28T18:30:00.000Z';
    const lastUsedAt = '2026-10-28T12:00:00.000Z';
    stubAccounts([
      account({ id: 'a1', label: 'My Max', lastUsedAt }),
      account({ id: 'a2', label: 'Olena Pro', mine: false, canManage: false, canReplaceSecret: false, status: 'limited', limitedUntil }),
      account({
        id: 'a3',
        label: 'Team key',
        kind: 'api_key',
        mine: false,
        hint: 'wxyz',
        status: 'disabled',
        lastError: 'invalid x-api-key',
      }),
    ]);

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByRole('listitem', { name: 'My Max' })).toBeInTheDocument();
    expect(within(row('My Max')).getByText('Your subscription')).toBeInTheDocument();
    expect(within(row('My Max')).getByText('…abcd')).toBeInTheDocument();
    expect(within(row('My Max')).getByText('Active')).toBeInTheDocument();
    expect(within(row('My Max')).getByText(`Last used ${formatAccountTime(lastUsedAt)}`)).toBeInTheDocument();

    expect(within(row('Olena Pro')).getByText('Member’s subscription')).toBeInTheDocument();
    expect(within(row('Olena Pro')).getByText(`Limited until ${formatAccountTime(limitedUntil)}`)).toBeInTheDocument();
    expect(within(row('Olena Pro')).queryByRole('button', { name: 'Actions for Olena Pro' })).not.toBeInTheDocument();

    expect(within(row('Team key')).getByText('Organization key')).toBeInTheDocument();
    expect(within(row('Team key')).getByText('Off')).toBeInTheDocument();
    expect(within(row('Team key')).getByText('invalid x-api-key')).toBeInTheDocument();
    expect(within(row('Team key')).getByText('Not used yet')).toBeInTheDocument();
  });

  it('explains what accounts are for when there are none', async () => {
    stubAccounts([]);

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Claude Code accounts' })).not.toBeInTheDocument();
  });

  it('adds the caller’s subscription token', async () => {
    const writes = stubAccounts([]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/claude setup-token/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Token or API key')).toHaveAttribute('type', 'password');

    await user.type(within(dialog).getByLabelText('Name'), 'My Max');
    await user.type(within(dialog).getByLabelText('Token or API key'), 'sk-ant-oat01-0123456789abcdefWXYZ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('listitem', { name: 'My Max' })).toBeInTheDocument();
    expect(within(row('My Max')).getByText('…WXYZ')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([
      { method: 'POST', body: { label: 'My Max', secret: 'sk-ant-oat01-0123456789abcdefWXYZ' } },
    ]);
  });

  it('tells a member that organization keys need an admin, and shows the refusal', async () => {
    stubAccounts([]);
    server.use(
      http.post(ACCOUNTS_URL, () => HttpResponse.json({ error: 'organization_admin_required' }, { status: 403 })),
    );
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Organization API keys can only be added by an organization admin\./),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Name'), 'Team key');
    await user.type(within(dialog).getByLabelText('Token or API key'), 'sk-ant-api03-0123456789abcdef');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only organization admins can add organization API keys. You can add your own subscription token.',
    );
  });

  it('tells an admin that organization keys serve everyone', async () => {
    stubAccounts([], true);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Add account' }));

    expect(within(await screen.findByRole('dialog')).getByText(/serves everyone’s runs/)).toBeInTheDocument();
  });

  it('shows the server’s message when it rejects the input', async () => {
    stubAccounts([]);
    server.use(
      http.post(ACCOUNTS_URL, () =>
        HttpResponse.json({ error: 'invalid_request', message: 'secret is too short' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Short');
    await user.type(within(dialog).getByLabelText('Token or API key'), 'sk-ant-oat01');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('secret is too short');
  });

  it('switches an account off and back on', async () => {
    const writes = stubAccounts([account({ id: 'a1', label: 'My Max' })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'My Max');
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off' }));
    expect(await within(row('My Max')).findByText('Off')).toBeInTheDocument();

    await openMenu(user, 'My Max');
    await user.click(await screen.findByRole('menuitem', { name: 'Turn on' }));
    expect(await within(row('My Max')).findByText('Active')).toBeInTheDocument();

    expect(writes).toEqual([
      { method: 'PATCH', id: 'a1', body: { disabled: true } },
      { method: 'PATCH', id: 'a1', body: { disabled: false } },
    ]);
  });

  it('offers replacing the secret only when allowed', async () => {
    stubAccounts([account({ id: 'a1', label: 'Olena Pro', mine: false, canReplaceSecret: false })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'Olena Pro');

    expect(await screen.findByRole('menuitem', { name: 'Turn off' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Replace secret' })).not.toBeInTheDocument();
  });

  it('removes an account after confirming', async () => {
    const writes = stubAccounts([account({ id: 'a1', label: 'My Max' }), account({ id: 'a2', label: 'Spare' })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'My Max');
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove My Max?')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'My Max' })).not.toBeInTheDocument());
    expect(row('Spare')).toBeInTheDocument();
    expect(writes).toEqual([{ method: 'DELETE', id: 'a1' }]);
  });

  it('shows the refusal when an action is not allowed', async () => {
    stubAccounts([account({ id: 'a1', label: 'My Max' })]);
    server.use(http.patch(`${ACCOUNTS_URL}/:id`, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'My Max');
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You can’t change this account.');
  });

  it('shows the server error when the list fails to load', async () => {
    server.use(
      http.get(ACCOUNTS_URL, () =>
        HttpResponse.json({ error: 'storage_unavailable', message: 'Credential storage is not available' }, { status: 503 }),
      ),
    );

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByText('Credential storage is not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
  });

  it('asks to sign in to an organization when there is none', async () => {
    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByText('Sign in to an organization to add Claude Code accounts.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
  });

  it('shows a loading state while the list is on its way', async () => {
    server.use(http.get(ACCOUNTS_URL, () => new Promise(() => {})));

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByRole('status', { name: 'Loading Claude Code accounts' })).toBeInTheDocument();
  });
});
