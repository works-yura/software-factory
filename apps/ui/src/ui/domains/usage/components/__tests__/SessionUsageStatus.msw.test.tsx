/**
 * The status line's token usage: the session's total and its context fill, and a popover that
 * splits the last turn and the session by input, cache and output with the estimated cost.
 * Drives the real hook and api client through MSW.
 */
import type { PricedUsageTurn, SessionUsage } from '@factory/harness/usage';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { ChatRuntimeContext } from '../../../chat/context/ChatRuntimeContext';
import { ChatSessionContext } from '../../../chat/context/ChatSessionContext';
import { SessionUsageStatus } from '../SessionUsageStatus';

function turn(overrides: Partial<PricedUsageTurn>): PricedUsageTurn {
  return {
    id: 't',
    sessionId: 'session-1',
    threadId: 'thread-1',
    runId: null,
    factoryProjectId: 'f',
    workItemId: null,
    kickoffId: null,
    role: null,
    userId: 'u',
    harnessId: 'claude-code',
    model: 'claude-sonnet-4-6',
    accountId: null,
    occurredAt: '2026-11-11T10:00:00.000Z',
    totals: { inputTokens: 1_200, cacheReadTokens: 40_000, cacheWriteTokens: 2_000, outputTokens: 800, reasoningTokens: 0 },
    stepCount: 2,
    contextTokens: 43_200,
    reportedCostUsd: null,
    totalTokens: 44_000,
    costUsd: 0.0312,
    costSource: 'estimated',
    ...overrides,
  };
}

function usage(turns: PricedUsageTurn[], context: SessionUsage['context']): SessionUsage {
  const totals = turns.reduce(
    (sum, entry) => ({
      inputTokens: sum.inputTokens + entry.totals.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + entry.totals.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + entry.totals.cacheWriteTokens,
      outputTokens: sum.outputTokens + entry.totals.outputTokens,
      reasoningTokens: sum.reasoningTokens + entry.totals.reasoningTokens,
    }),
    { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
  return {
    sessionId: 'session-1',
    turns,
    total: {
      turns: turns.length,
      totals,
      totalTokens: turns.reduce((sum, entry) => sum + entry.totalTokens, 0),
      costUsd: turns.reduce((sum, entry) => sum + entry.costUsd, 0),
      reportedCostUsd: 0,
      unpricedTurns: turns.filter(entry => entry.costSource === 'unpriced').length,
    },
    context,
  };
}

function renderStatus(sessionId = 'session-1') {
  return renderWithProviders(
    <ChatSessionContext.Provider
      value={{
        sessionId,
        resourceId: 'resource-1',
        sessionEnabled: true,
        resourceReady: true,
        sandboxReady: true,
        sandboxPreparing: false,
        resourceEnabled: true,
        baseUrl: '',
        kind: 'user',
      }}
    >
      <ChatRuntimeContext.Provider
        value={{
          runsStarted: 0,
          followUpCount: 0,
          omPhase: 'idle',
          bufferingMessages: false,
          bufferingObservations: false,
          tokensPerSec: 0,
        }}
      >
        <SessionUsageStatus />
      </ChatRuntimeContext.Provider>
    </ChatSessionContext.Provider>,
  );
}

describe('SessionUsageStatus', () => {
  it('shows the session total and context fill, and splits the last turn and the session in the popover', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/sessions/session-1`, () =>
        HttpResponse.json({
          usage: usage(
            [
              turn({ id: 'a' }),
              turn({
                id: 'b',
                occurredAt: '2026-11-11T10:05:00.000Z',
                totals: { inputTokens: 300, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 1_700, reasoningTokens: 400 },
                totalTokens: 52_000,
                costUsd: 0.0425,
                contextTokens: 50_300,
              }),
            ],
            { tokens: 50_300, window: 200_000 },
          ),
        }),
      ),
    );
    const user = userEvent.setup();
    renderStatus();

    const trigger = await screen.findByRole('button', { name: 'Token usage: 96K tokens this session' });
    expect(within(trigger).getByRole('meter', { name: 'Context window' })).toHaveAttribute('aria-valuenow', '50300');

    await user.click(trigger);
    expect(await screen.findByText('Session usage')).toBeInTheDocument();
    expect(screen.getByText('2 turns')).toBeInTheDocument();
    const table = screen.getByRole('table');
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(`^${name}`) });
    expect(within(row('Cache read')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['50K', '90K']);
    expect(within(row('Output')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['1.7K', '2.5K']);
    expect(within(row('of it reasoning')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['400', '400']);
    expect(within(row('Estimated cost')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['$0.04', '≈ $0.07']);
    expect(screen.getByText('50.3K of 200K')).toBeInTheDocument();
    expect(screen.getByText(/Estimated at API list prices/)).toBeInTheDocument();
  });

  it('says a model has no price instead of showing it as free, and stays hidden before any turn', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/sessions/session-2`, () =>
        HttpResponse.json({
          usage: usage([turn({ model: 'mystery', costUsd: 0, costSource: 'unpriced' })], { tokens: 43_200, window: null }),
        }),
      ),
    );
    const user = userEvent.setup();
    renderStatus('session-2');
    await user.click(await screen.findByRole('button', { name: 'Token usage: 44K tokens this session' }));
    const table = await screen.findByRole('table');
    expect(within(within(table).getByRole('row', { name: /^Estimated cost/ })).getByRole('cell').textContent).toBe('no price');
    expect(screen.getByText('43.2K in context')).toBeInTheDocument();

    renderStatus('session-empty');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
