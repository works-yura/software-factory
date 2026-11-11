/**
 * The accounts section (one for every turn-based harness; Claude Code's here, Codex's below) lists the Claude sign-ins Claude Code
 * sessions rotate through and lets members switch off, rename and remove them.
 * Signing in is the only way to add one: there is no token or key to paste,
 * and a pasted one left from before shows as old, only to be removed.
 * Drives the real hooks + api client through MSW.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { CredentialAccountInfo, CredentialAccountsResponse } from '../../../../../../../api/types';
import { server } from '../../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../../e2e/ui/render';
import { CLAUDE_CODE_ACCOUNTS, CODEX_ACCOUNTS } from '../harnessAccounts';
import { formatAccountTime, HarnessAccountsSection } from '../HarnessAccountsSection';

const ClaudeAccountsSection = () => <HarnessAccountsSection accounts={CLAUDE_CODE_ACCOUNTS} />;

const ACCOUNTS_URL = `${TEST_BASE_URL}/web/config/providers/anthropic/accounts`;

function account(overrides: Partial<CredentialAccountInfo> & Pick<CredentialAccountInfo, 'id' | 'label'>) {
  return {
    kind: 'claude_login',
    mine: true,
    priority: 0,
    status: 'active',
    hint: '',
    canManage: true,
    legacy: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  } satisfies CredentialAccountInfo;
}

/** A stateful accounts store: GET reflects every write made through the stubs. */
function stubAccounts(initial: CredentialAccountInfo[]) {
  let accounts = [...initial];
  const writes: Array<{ method: string; id?: string; body?: unknown }> = [];
  server.use(
    http.get(ACCOUNTS_URL, () => HttpResponse.json({ accounts } satisfies CredentialAccountsResponse)),
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

describe('HarnessAccountsSection for Claude Code', () => {
  it('lists each sign-in with whose it is, its status, last error and last use', async () => {
    const limitedUntil = '2026-10-28T18:30:00.000Z';
    const lastUsedAt = '2026-10-28T12:00:00.000Z';
    stubAccounts([
      account({ id: 'a1', label: 'alice@example.com', lastUsedAt }),
      account({ id: 'a2', label: 'olena@example.com', mine: false, canManage: false, status: 'limited', limitedUntil }),
      account({ id: 'a3', label: 'bob@example.com', mine: false, status: 'disabled', lastError: 'sign in to Claude again' }),
    ]);

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByRole('listitem', { name: 'alice@example.com' })).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText('Your Claude sign-in')).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText('Active')).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText(`Last used ${formatAccountTime(lastUsedAt)}`)).toBeInTheDocument();

    expect(within(row('olena@example.com')).getByText('Member’s Claude sign-in')).toBeInTheDocument();
    expect(within(row('olena@example.com')).getByText(`Limited until ${formatAccountTime(limitedUntil)}`)).toBeInTheDocument();
    expect(within(row('olena@example.com')).queryByRole('button', { name: 'Actions for olena@example.com' })).not.toBeInTheDocument();

    expect(within(row('bob@example.com')).getByText('Off')).toBeInTheDocument();
    expect(within(row('bob@example.com')).getByText('sign in to Claude again')).toBeInTheDocument();
    expect(within(row('bob@example.com')).getByText('Not used yet')).toBeInTheDocument();
  });

  it('offers no way to paste a token or key', async () => {
    stubAccounts([account({ id: 'a1', label: 'alice@example.com' })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'alice@example.com');
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /secret/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
    expect(screen.queryByText(/setup-token/)).not.toBeInTheDocument();
  });

  it('marks a pasted token left from before as old, and only lets it be removed', async () => {
    const writes = stubAccounts([
      account({ id: 'old', label: 'Team key', kind: 'api_key', mine: false, hint: 'wxyz', legacy: true }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByRole('listitem', { name: 'Team key' })).toBeInTheDocument();
    expect(within(row('Team key')).getByText('Old token: remove it')).toBeInTheDocument();
    expect(within(row('Team key')).queryByText('Active')).not.toBeInTheDocument();
    // Nothing runs on it, so the section still says there is no sign-in.
    expect(screen.getByText(/No Claude sign-ins yet/)).toBeInTheDocument();

    await openMenu(user, 'Team key');
    expect(screen.queryByRole('menuitem', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Team key' })).not.toBeInTheDocument());
    expect(writes).toEqual([{ method: 'DELETE', id: 'old' }]);
  });

  it('explains what sign-ins are for when there are none', async () => {
    stubAccounts([]);

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByText(/No Claude sign-ins yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Claude Code accounts' })).not.toBeInTheDocument();
  });

  it('switches a sign-in off and back on', async () => {
    const writes = stubAccounts([account({ id: 'a1', label: 'alice@example.com' })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'alice@example.com');
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off' }));
    expect(await within(row('alice@example.com')).findByText('Off')).toBeInTheDocument();

    await openMenu(user, 'alice@example.com');
    await user.click(await screen.findByRole('menuitem', { name: 'Turn on' }));
    expect(await within(row('alice@example.com')).findByText('Active')).toBeInTheDocument();

    expect(writes).toEqual([
      { method: 'PATCH', id: 'a1', body: { disabled: true } },
      { method: 'PATCH', id: 'a1', body: { disabled: false } },
    ]);
  });

  it('renames a sign-in, and shows the server’s message when it refuses the name', async () => {
    const writes = stubAccounts([account({ id: 'a1', label: 'alice@example.com' })]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'alice@example.com');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('alice@example.com');
    await user.clear(name);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(name, 'Work Max');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('listitem', { name: 'Work Max' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([{ method: 'PATCH', id: 'a1', body: { label: 'Work Max' } }]);

    server.use(
      http.patch(`${ACCOUNTS_URL}/:id`, () =>
        HttpResponse.json({ error: 'invalid_request', message: 'label is required' }, { status: 400 }),
      ),
    );
    await openMenu(user, 'Work Max');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const again = await screen.findByRole('dialog');
    await user.type(within(again).getByLabelText('Name'), '!');
    await user.keyboard('{Enter}');
    expect(await within(again).findByRole('alert')).toHaveTextContent('label is required');
  });

  it('removes a sign-in after confirming', async () => {
    const writes = stubAccounts([
      account({ id: 'a1', label: 'alice@example.com' }),
      account({ id: 'a2', label: 'spare@example.com' }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'alice@example.com');
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove alice@example.com?')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'alice@example.com' })).not.toBeInTheDocument());
    expect(row('spare@example.com')).toBeInTheDocument();
    expect(writes).toEqual([{ method: 'DELETE', id: 'a1' }]);
  });

  it('shows the refusal when an action is not allowed', async () => {
    stubAccounts([account({ id: 'a1', label: 'alice@example.com' })]);
    server.use(http.patch(`${ACCOUNTS_URL}/:id`, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await openMenu(user, 'alice@example.com');
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
  });

  it('asks to sign in to an organization when there is none', async () => {
    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByText('Sign in to an organization to use Claude Code accounts.')).toBeInTheDocument();
  });

  it('shows a loading state while the list is on its way', async () => {
    server.use(http.get(ACCOUNTS_URL, () => new Promise(() => {})));

    renderWithProviders(<ClaudeAccountsSection />);

    expect(await screen.findByRole('status', { name: 'Loading Claude Code accounts' })).toBeInTheDocument();
  });
});

describe('HarnessAccountsSection sign-in with Claude', () => {
  const SIGN_IN_URL = `${ACCOUNTS_URL}/sign-in`;
  const signedIn = account({ id: 'login-1', label: 'alice@example.com' });

  function stubSignIn({ finish }: { finish: 'done' | 'error' | 'never' }) {
    let polls = 0;
    const calls: string[] = [];
    server.use(
      http.get('*/web/config/features', () => HttpResponse.json({ knowledge: false, claudeCode: true, claudeSignIn: true })),
      http.post(SIGN_IN_URL, () => {
        calls.push('start');
        return HttpResponse.json({ signIn: { id: 'flow-1', status: 'pending' } }, { status: 202 });
      }),
      http.get(`${SIGN_IN_URL}/:id`, () => {
        polls += 1;
        if (finish === 'never' || polls < 2) return HttpResponse.json({ signIn: { id: 'flow-1', status: 'pending' } });
        return finish === 'done'
          ? HttpResponse.json({ signIn: { id: 'flow-1', status: 'done', account: signedIn } })
          : HttpResponse.json({ signIn: { id: 'flow-1', status: 'error', error: 'Claude sign-in did not finish.' } });
      }),
      http.delete(`${SIGN_IN_URL}/:id`, () => {
        calls.push('cancel');
        return HttpResponse.json({ cancelled: true });
      }),
    );
    return calls;
  }

  it('signs in, waits while the person finishes in the browser, then lists the new sign-in', async () => {
    const accounts: CredentialAccountInfo[] = [];
    stubAccounts(accounts);
    stubSignIn({ finish: 'done' });
    // The list the server returns once the sign-in is filed.
    let listed = 0;
    server.use(
      http.get(ACCOUNTS_URL, () =>
        HttpResponse.json({ accounts: listed++ === 0 ? [] : [signedIn] } satisfies CredentialAccountsResponse),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ClaudeAccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    expect(await screen.findByText(/Finish signing in on the Claude page/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeDisabled();

    expect(await screen.findByText('Signed in as alice@example.com.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'alice@example.com' })).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText('Your Claude sign-in')).toBeInTheDocument();
    expect(within(row('alice@example.com')).queryByText(/^…/)).not.toBeInTheDocument();
  });

  it('shows why a sign-in failed, and cancels one still waiting', async () => {
    stubAccounts([]);
    stubSignIn({ finish: 'error' });
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<ClaudeAccountsSection />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    expect(await screen.findByText('Claude sign-in did not finish.', {}, { timeout: 5000 })).toBeInTheDocument();
    unmount();

    const calls = stubSignIn({ finish: 'never' });
    renderWithProviders(<ClaudeAccountsSection />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls).toEqual(['start', 'cancel']));
  });

  it('asks the owner of a refused sign-in to sign in again, and hides sign-in where the server does not offer it', async () => {
    stubAccounts([{ ...signedIn, status: 'disabled', needsSignIn: true, lastError: 'sign in to Claude again' }]);
    renderWithProviders(<ClaudeAccountsSection />);
    expect(await screen.findByRole('listitem', { name: 'alice@example.com' })).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText('Sign in again')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
  });
});

describe('HarnessAccountsSection for Codex', () => {
  const CODEX_URL = `${TEST_BASE_URL}/web/config/providers/openai-codex/accounts`;
  const signedIn = account({ id: 'codex-1', label: 'alice@example.com', kind: 'codex_login' });

  it('lists ChatGPT sign-ins, says to finish in the page that opened while signing in, then the new sign-in', async () => {
    let listed = 0;
    let polls = 0;
    server.use(
      http.get('*/web/config/features', () => HttpResponse.json({ knowledge: false, codex: true, codexSignIn: true })),
      http.get(CODEX_URL, () => HttpResponse.json({ accounts: listed++ === 0 ? [] : [signedIn] } satisfies CredentialAccountsResponse)),
      http.post(`${CODEX_URL}/sign-in`, () => HttpResponse.json({ signIn: { id: 'flow-1', status: 'pending' } }, { status: 202 })),
      http.get(`${CODEX_URL}/sign-in/:id`, () => {
        polls += 1;
        return polls < 3
          ? HttpResponse.json({ signIn: { id: 'flow-1', status: 'pending' } })
          : HttpResponse.json({ signIn: { id: 'flow-1', status: 'done', account: signedIn } });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<HarnessAccountsSection accounts={CODEX_ACCOUNTS} />);

    expect(await screen.findByText('Codex accounts')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
    expect(
      await screen.findByText(/Finish signing in on the ChatGPT page that opened in your browser/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    expect(await screen.findByText('Signed in as alice@example.com.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'alice@example.com' })).toBeInTheDocument();
    expect(within(row('alice@example.com')).getByText('Your ChatGPT sign-in')).toBeInTheDocument();
  });
});
