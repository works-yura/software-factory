/**
 * A card's usage: its total over every run and each run's role, harness, model, tokens and cost; and a
 * run's end in the card's activity says what it spent. Drives the real hook and api client through MSW.
 */
import type { WorkItemUsage } from '@factory/harness/usage';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { ActivityEvent } from '../../../factory/components/WorkItemActivity';
import type { AuditEvent } from '../../../factory/services/audit';
import { CardUsage } from '../CardUsage';

const totals = { inputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 5_000, outputTokens: 5_000, reasoningTokens: 0 };
const aggregate = (turns: number, totalTokens: number, costUsd: number, unpricedTurns = 0) => ({
  turns,
  totals,
  totalTokens,
  costUsd,
  reportedCostUsd: 0,
  unpricedTurns,
});

describe('CardUsage', () => {
  it("shows the card's total and its runs, newest first, with a model without a price said so", async () => {
    const requested: string[] = [];
    const usage: WorkItemUsage = {
      workItemId: 'card-1',
      total: aggregate(5, 1_240_000, 1.82, 1),
      runs: [
        {
          kickoffId: 'k2',
          role: 'reviewer',
          sessionId: 's2',
          harnessId: 'codex',
          model: 'gpt-5.1-codex',
          endedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          ...aggregate(2, 240_000, 0.32),
        },
        { kickoffId: 'k1', role: null, sessionId: 's1', harnessId: 'claude-code', model: null, endedAt: '2026-11-10T09:00:00.000Z', ...aggregate(3, 1_000_000, 0, 3) },
      ],
    };
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/work-items`, ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('ids') ?? '');
        return HttpResponse.json({ workItems: { 'card-1': usage } });
      }),
    );
    renderWithProviders(<CardUsage workItemId="card-1" enabled />);

    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(within(section).getByText('1.2M tokens · ≈ $1.82')).toBeInTheDocument();
    const runs = within(within(section).getByRole('list', { name: 'Runs' })).getAllByRole('listitem');
    expect(runs[0]).toHaveTextContent('reviewer · Codex · gpt-5.1-codex');
    expect(runs[0]).toHaveTextContent('240K tokens · ≈ $0.32');
    expect(runs[1]).toHaveTextContent('Claude Code · Model not reported');
    expect(runs[1]).toHaveTextContent('1M tokens · no price');
    expect(requested).toEqual(['card-1']);
  });

  it('shows nothing for a card nothing ran on, and asks nothing while the panel is closed', async () => {
    let asked = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/work-items`, () => {
        asked += 1;
        return HttpResponse.json({ workItems: {} });
      }),
    );
    renderWithProviders(
      <>
        <CardUsage workItemId="card-2" enabled />
        <CardUsage workItemId="card-3" enabled={false} />
      </>,
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'Usage' })).not.toBeInTheDocument();
    expect(asked).toBe(1);
  });

  it("names a run's tokens on its end in the card's activity", () => {
    const event = {
      id: 'e1',
      action: 'factory.run.ended',
      actorId: 'agent:thread-1',
      actorType: 'agent',
      occurredAt: '2026-11-10T09:00:00.000Z',
      metadata: { reason: 'complete', usage: { status: 'recorded', stepCount: 3, totals: { promptTokens: 40_000, completionTokens: 2_500, totalTokens: 42_500 }, steps: [] } },
    } as unknown as AuditEvent;
    renderWithProviders(<ActivityEvent event={event} actors={{}} board={undefined} />);
    expect(screen.getByText(/42\.5K tokens/)).toBeInTheDocument();
  });
});
