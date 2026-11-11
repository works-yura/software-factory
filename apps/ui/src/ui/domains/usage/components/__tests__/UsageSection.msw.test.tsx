/**
 * Settings › Usage: the period's tokens, cost, turns and cache share, per day, and split by
 * harness, model, role, session, account and Factory; this Factory or all of them, over 7, 30 or 90 days.
 * Drives the real hook and api client through MSW.
 */
import type { UsageAggregate } from '@factory/harness/usage';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { UsageSummaryResponse } from '../../../../../api/types';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { usagePeriod, UsageSection } from '../UsageSection';

const aggregate = (totalTokens: number, costUsd: number, unpricedTurns = 0, turns = 1): UsageAggregate => ({
  turns,
  totals: { inputTokens: totalTokens * 0.1, cacheReadTokens: totalTokens * 0.8, cacheWriteTokens: 0, outputTokens: totalTokens * 0.1, reasoningTokens: 0 },
  totalTokens,
  costUsd,
  reportedCostUsd: 0,
  unpricedTurns,
});

function summary(): UsageSummaryResponse {
  return {
    from: '2026-11-10',
    to: '2026-11-11',
    total: aggregate(3_000_000, 12.5, 1, 14),
    byDay: [
      { day: '2026-11-10', ...aggregate(1_000_000, 4) },
      { day: '2026-11-11', ...aggregate(2_000_000, 8.5) },
    ],
    byHarness: [
      { key: 'claude-code', ...aggregate(2_000_000, 10) },
      { key: 'codex', ...aggregate(1_000_000, 2.5) },
    ],
    byModel: [
      { key: 'claude-opus-5-5', ...aggregate(2_000_000, 10) },
      { key: '', ...aggregate(1_000_000, 0, 1) },
    ],
    byAccount: [{ key: 'acc-1', ...aggregate(3_000_000, 12.5) }],
    byFactory: [{ key: 'factory-1', ...aggregate(3_000_000, 12.5) }],
    byRole: [
      { key: 'implementer', ...aggregate(2_500_000, 11) },
      { key: '', ...aggregate(500_000, 1.5) },
    ],
    bySession: [
      { key: 'session-1', ...aggregate(2_000_000, 9) },
      { key: 'session-2', ...aggregate(1_000_000, 3.5) },
    ],
    labels: {
      accounts: { 'acc-1': 'alice@example.com' },
      factories: { 'factory-1': 'Payments' },
      sessions: { 'session-1': 'Fix login flow' },
    },
  };
}

describe('UsageSection', () => {
  it('shows the totals and the breakdown, and asks again for another period or every Factory', async () => {
    const asked: Array<Record<string, string>> = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/summary`, ({ request }) => {
        asked.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json(summary());
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<UsageSection factoryId="factory-1" />);

    const kpis = await screen.findByRole('group', { name: 'Usage' });
    await waitFor(() => expect(within(kpis).getByText('3M')).toBeInTheDocument());
    expect(within(kpis).getByText('$12.50')).toBeInTheDocument();
    expect(within(kpis).getByText('14')).toBeInTheDocument();
    expect(within(kpis).getByText('89%')).toBeInTheDocument();
    expect(screen.getByText(/1 turns have no price/)).toBeInTheDocument();
    expect(asked[0]).toEqual({ ...usagePeriod(30), factoryProjectId: 'factory-1' });

    // By harness first, then by model, account and Factory, named as people know them.
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('≈ $2.50')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Model' }));
    expect(await screen.findByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText('Model not reported')).toBeInTheDocument();
    expect(screen.getByText('no price')).toBeInTheDocument();
    // By the role each card run played, and the sessions that spent most, by title.
    await user.click(screen.getByRole('tab', { name: 'Role' }));
    expect(await screen.findByText('implementer')).toBeInTheDocument();
    expect(screen.getByText('Outside a card run')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Session' }));
    expect(await screen.findByText('Fix login flow')).toBeInTheDocument();
    expect(screen.getByText('Untitled session')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Factory' }));
    expect(await screen.findByText('Payments')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(asked.at(-1)).toEqual({ ...usagePeriod(7), factoryProjectId: 'factory-1' }));
    await user.click(screen.getByRole('radio', { name: 'All Factories' }));
    await waitFor(() => expect(asked.at(-1)).toEqual(usagePeriod(7)));
  });

  it('says when usage cannot be loaded', async () => {
    server.use(http.get(`${TEST_BASE_URL}/web/usage/summary`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    renderWithProviders(<UsageSection factoryId="factory-1" />);
    expect(await screen.findByText('Couldn’t load usage.')).toBeInTheDocument();
  });
});
