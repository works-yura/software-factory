/**
 * The status line's limits indicator: the session's account, its tightest window as a ring with the
 * share and reset, amber/red past 80/95 %, and a popover listing every window. Drives the real hooks
 * and api client through MSW; nothing in it knows which harness reported the windows.
 */
import type { PricedUsageTurn, SessionUsage, UsageWindow } from '@factory/harness/usage';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { UsageLimitsAccount, UsageLimitsResponse } from '../../../../../api/types';
import { ChatRuntimeContext } from '../../../chat/context/ChatRuntimeContext';
import { ChatSessionContext } from '../../../chat/context/ChatSessionContext';
import { UsageLimitsStatus } from '../UsageLimitsStatus';

const HOUR = 3_600_000;
/** Half a minute past the hour mark, so a countdown reads whole hours however long the render takes. */
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR + 30_000).toISOString();

function sessionUsage(sessionId: string, accountIds: Array<string | null>): SessionUsage {
  const turns = accountIds.map(
    (accountId, index): PricedUsageTurn => ({
      id: `t${index}`,
      sessionId,
      threadId: 'thread-1',
      runId: null,
      factoryProjectId: 'f',
      workItemId: null,
      kickoffId: null,
      role: null,
      userId: 'u',
      harnessId: accountId ? 'claude-code' : 'mastra',
      model: 'claude-sonnet-4-6',
      accountId,
      occurredAt: '2026-11-11T10:00:00.000Z',
      totals: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 },
      stepCount: 1,
      contextTokens: 100,
      reportedCostUsd: null,
      totalTokens: 110,
      costUsd: 0.001,
      costSource: 'estimated',
    }),
  );
  return {
    sessionId,
    turns,
    total: {
      turns: turns.length,
      totals: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 },
      totalTokens: 110,
      costUsd: 0.001,
      reportedCostUsd: 0,
      unpricedTurns: 0,
    },
    context: null,
  };
}

function limitsAccount(accountId: string, windows: UsageWindow[], extra: Partial<UsageLimitsAccount> = {}): UsageLimitsAccount {
  return {
    accountId,
    label: 'alice@example.com',
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    provider: 'anthropic',
    disabled: false,
    usage: { checkedAt: new Date().toISOString(), source: 'probe', windows },
    ...extra,
  };
}

function renderStatus(sessionId: string) {
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
        <UsageLimitsStatus />
      </ChatRuntimeContext.Provider>
    </ChatSessionContext.Provider>,
  );
}

describe('UsageLimitsStatus', () => {
  it('rings the tightest window of the session’s account and lists every window in the popover', async () => {
    const windows: UsageWindow[] = [
      { id: 'five_hour', kind: 'session', usedPercent: 40, windowDurationMins: 300, resetsAt: inHours(2) },
      { id: 'seven_day', kind: 'weekly', usedPercent: 96, windowDurationMins: 10_080, resetsAt: inHours(48) },
      { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 82, windowDurationMins: 10_080, resetsAt: inHours(48) },
      { id: 'monthly_spend', kind: 'spend', usedPercent: 9 },
    ];
    const asked: string[] = [];
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/sessions/session-1`, () =>
        // The latest turn with an account names it; an older one ran on another.
        HttpResponse.json({ usage: sessionUsage('session-1', ['acc-old', 'acc-1', null]) }),
      ),
      http.get(`${TEST_BASE_URL}/web/usage/limits`, ({ request }) => {
        const refresh = new URL(request.url).searchParams.get('refresh');
        asked.push(refresh ?? '');
        const fresh = refresh === '1' ? windows.map(window => (window.id === 'seven_day' ? { ...window, usedPercent: 97 } : window)) : windows;
        return HttpResponse.json({
          accounts: [
            limitsAccount('acc-old', [{ id: 'primary', kind: 'session', usedPercent: 5 }], { label: 'old@example.com' }),
            limitsAccount('acc-1', fresh),
          ],
        } satisfies UsageLimitsResponse);
      }),
    );
    const user = userEvent.setup();
    renderStatus('session-1');

    const trigger = await screen.findByRole('button', {
      name: 'Usage limits of alice@example.com: Weekly 96% used, resets in 2d 0h',
    });
    const ring = within(trigger).getByRole('meter', { name: 'Weekly' });
    expect(ring).toHaveAttribute('aria-valuenow', '96');
    expect(ring).toHaveAttribute('data-level', 'critical');
    expect(trigger).toHaveTextContent('96%2d 0h');
    expect(asked).toEqual(['']);

    await user.click(trigger);
    expect(await screen.findByText('Usage limits')).toBeInTheDocument();
    expect(screen.getByText('Claude Code · alice@example.com')).toBeInTheDocument();
    // Opening asks the providers again; the newer reading replaces the stored one.
    expect(await screen.findByText('97%')).toBeInTheDocument();
    expect(asked).toContain('1');
    const dialog = screen.getByRole('dialog');
    const meters = within(dialog).getAllByRole('meter');
    expect(meters.map(meter => meter.getAttribute('aria-label'))).toEqual(['5-hour', 'Weekly', 'Weekly · Opus', 'Extra usage']);
    expect(meters.map(meter => meter.getAttribute('data-level'))).toEqual(['ok', 'critical', 'warning', 'ok']);
    expect(within(dialog).getByText(/^resets in 2h 0m · /)).toBeInTheDocument();
  });

  it('reads a window whose reset has passed as empty, and shows nothing for a session without an account', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/sessions/session-2`, () => HttpResponse.json({ usage: sessionUsage('session-2', ['acc-2']) })),
      http.get(`${TEST_BASE_URL}/web/usage/sessions/session-api-key`, () =>
        HttpResponse.json({ usage: sessionUsage('session-api-key', [null]) }),
      ),
      http.get(`${TEST_BASE_URL}/web/usage/limits`, () =>
        HttpResponse.json({
          accounts: [
            limitsAccount(
              'acc-2',
              [
                { id: 'primary', kind: 'session', usedPercent: 100, windowDurationMins: 300, resetsAt: new Date(Date.now() - HOUR).toISOString() },
                { id: 'secondary', kind: 'weekly', usedPercent: 30, windowDurationMins: 10_080, resetsAt: inHours(30) },
              ],
              { label: 'codex@example.com', harnessId: 'codex', harnessName: 'Codex', provider: 'openai-codex' },
            ),
          ],
        } satisfies UsageLimitsResponse),
      ),
    );
    renderStatus('session-2');
    const trigger = await screen.findByRole('button', { name: 'Usage limits of codex@example.com: Weekly 30% used, resets in 1d 6h' });
    expect(within(trigger).getByRole('meter')).toHaveAttribute('data-level', 'ok');

    renderStatus('session-api-key');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
