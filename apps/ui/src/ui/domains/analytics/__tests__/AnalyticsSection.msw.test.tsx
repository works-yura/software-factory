/**
 * Settings › Analytics: one preset window over the work metrics and the usage summary, KPI cards
 * whose trend grows into the daily chart, tabbed breakdowns, and the empty states. Renders the
 * real routes and hooks through MSW.
 */
import type { UsageAggregate } from '@factory/harness/usage';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { UsageLimitsResponse, UsageSummaryResponse } from '../../../../api/types';
import { server } from '../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../e2e/ui/render';
import { rangeWindow } from '../ranges';
import type { FactoryMetrics } from '../../factory/services/metrics';
import { createAppRoutes } from '../../../router';

const FACTORY_ID = 'fp-1';
const PROJECT = `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}`;

const aggregate = (totalTokens: number, costUsd: number, turns = 1, unpricedTurns = 0): UsageAggregate => ({
  turns,
  totals: {
    inputTokens: totalTokens * 0.1,
    cacheReadTokens: totalTokens * 0.8,
    cacheWriteTokens: 0,
    outputTokens: totalTokens * 0.1,
    reasoningTokens: 0,
  },
  totalTokens,
  costUsd,
  reportedCostUsd: 0,
  unpricedTurns,
});

function usageSummary(): UsageSummaryResponse {
  return {
    from: '2026-11-10',
    to: '2026-11-11',
    total: aggregate(3_000_000, 12.5, 14, 1),
    byDay: [
      { day: '2026-11-10', ...aggregate(1_000_000, 4, 6) },
      { day: '2026-11-11', ...aggregate(2_000_000, 8.5, 8) },
    ],
    byHarness: [
      { key: 'claude-code', ...aggregate(2_000_000, 10) },
      { key: 'codex', ...aggregate(1_000_000, 2.5) },
    ],
    byModel: [
      { key: 'claude-opus-5-5', ...aggregate(2_000_000, 10) },
      { key: '', ...aggregate(1_000_000, 0, 1, 1) },
    ],
    byAccount: [{ key: 'acc-1', ...aggregate(3_000_000, 12.5) }],
    byFactory: [{ key: FACTORY_ID, ...aggregate(3_000_000, 12.5) }],
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
      factories: { [FACTORY_ID]: 'Acme Factory' },
      sessions: { 'session-1': 'Fix login flow' },
    },
  };
}

const zero = (): UsageSummaryResponse => ({
  ...usageSummary(),
  total: aggregate(0, 0, 0),
  byDay: [],
  byHarness: [],
  byModel: [],
  byAccount: [],
  byFactory: [],
  byRole: [],
  bySession: [],
});

function workMetrics(): FactoryMetrics {
  return {
    daysCovered: 3,
    throughput: [
      { date: '2026-11-09', count: 1 },
      { date: '2026-11-10', count: 0 },
      { date: '2026-11-11', count: 2 },
    ],
    leadTime: { medianMs: 3 * 3_600_000, p90Ms: 26 * 3_600_000, samples: 3 },
    wipTotal: 4,
    sourceMix: [
      { source: 'github:issue', count: 3 },
      { source: 'manual', count: 1 },
    ],
    agentCoverage: [
      { stage: 'triage', passes: 4, byAgent: 3, outcomes: { done: 2, canceled: 0, reworked: 1, inFlight: 0 } },
    ],
  };
}

const quietMetrics = (): FactoryMetrics => ({
  daysCovered: 30,
  throughput: [],
  leadTime: { medianMs: null, p90Ms: null, samples: 0 },
  wipTotal: 0,
  sourceMix: [],
  agentCoverage: [],
});

function card(id: string, sessions: Record<string, unknown>) {
  return {
    id,
    orgId: 'org-1',
    createdBy: 'user-1',
    factoryProjectId: FACTORY_ID,
    externalSource: null,
    parentWorkItemId: null,
    title: `Card ${id}`,
    stages: ['done'],
    stageHistory: [{ stage: 'done', enteredAt: '2026-01-01T00:00:00.000Z', by: 'user-1' }],
    sessions,
    metadata: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Stubs {
  metrics?: FactoryMetrics;
  usage?: UsageSummaryResponse;
  workItems?: unknown[];
}

function stub({ metrics = workMetrics(), usage = usageSummary(), workItems = [] }: Stubs = {}) {
  const asked = { metrics: [] as Array<Record<string, string>>, usage: [] as Array<Record<string, string>> };
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme Factory', repositories: [] }] }),
    ),
    http.get(PROJECT, () => HttpResponse.json({ project: { id: FACTORY_ID, name: 'Acme Factory', harness: 'mastra' } })),
    http.get(`${PROJECT}/work-records`, () => HttpResponse.json({ workRecords: [] })),
    http.get(`${PROJECT}/sessions`, () => HttpResponse.json({ sessions: [] })),
    http.get(`${TEST_BASE_URL}/web/github/subscriptions`, () => HttpResponse.json({ subscriptions: [] })),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId/permissions`, () => HttpResponse.json({})),
    http.get(`${PROJECT}/work-items`, () => HttpResponse.json({ workItems, runningSessionIds: ['session-run'] })),
    http.get(`${PROJECT}/health/thresholds`, () => HttpResponse.json({ thresholds: [14400, 86400, 259200] })),
    http.get(`${PROJECT}/metrics`, ({ request }) => {
      asked.metrics.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json({ metrics });
    }),
    http.get(`${TEST_BASE_URL}/web/usage/summary`, ({ request }) => {
      asked.usage.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json(usage);
    }),
  );
  return asked;
}

const SECTION = `/factories/${FACTORY_ID}/settings/analytics`;

function renderRoute(path = SECTION) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] });
  return { router, ...renderWithProviders(<RouterProvider router={router} />) };
}

describe('Analytics settings section', () => {
  it('reads the work and the usage of this Factory over the last 30 days', async () => {
    const asked = stub();
    renderRoute();

    const completed = await screen.findByRole('button', { name: /^Completed: 3, 1 per day\. Show/ });
    expect(completed).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Median lead time')).toBeInTheDocument();
    expect(screen.getByText('3h')).toBeInTheDocument();
    expect(screen.getByText('p90 1d 2h · 3 samples')).toBeInTheDocument();
    expect(screen.getByText('1 agent running now')).toBeInTheDocument();

    const usage = await screen.findByRole('button', { name: /^Tokens: 3M\. Show the daily chart/ });
    expect(usage).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Est\. cost: \$12\.50\./ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Turns: 14\./ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cache share: 89%\./ })).toBeInTheDocument();
    expect(screen.getByText(/1 turns have no price/)).toBeInTheDocument();

    const range = rangeWindow(30);
    expect(asked.metrics[0]).toEqual(range);
    expect(asked.usage[0]).toEqual({ ...range, factoryProjectId: FACTORY_ID });
  });

  it('shows usage while the work metrics still load, each section with its own placeholder', async () => {
    stub();
    server.use(
      http.get(`${PROJECT}/metrics`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderRoute();

    expect(await screen.findByRole('button', { name: /^Tokens: 3M\./ })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading Factory analytics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Completed:/ })).not.toBeInTheDocument();
  });

  it('grows one KPI at a time into its full daily chart', async () => {
    stub();
    const user = userEvent.setup();
    renderRoute();

    await user.click(await screen.findByRole('button', { name: /^Completed: 3.*Show the daily completions chart/ }));
    expect(screen.getByText('Daily completions over 3 days')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide the daily completions chart/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /^Tokens: 3M\. Show the daily chart/ }));
    expect(screen.getByText(/Tokens per day: input/)).toBeInTheDocument();
    expect(screen.queryByText('Daily completions over 3 days')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Tokens: 3M\. Hide the daily chart/ }));
    expect(screen.queryByText(/Tokens per day: input/)).not.toBeInTheDocument();
  });

  it('switches the work and usage breakdowns between their tabs', async () => {
    stub();
    const user = userEvent.setup();
    renderRoute();

    // Work opens on queue health; nothing in flight on this board.
    expect(await screen.findByRole('tab', { name: /Queue health/, selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Work intake/ }));
    expect(await screen.findByText('Where new work entered during this period.')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'GitHub issues: 3 items, 75%' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Automation coverage/ }));
    expect(
      await screen.findByRole('img', { name: 'Triage: 75% agent-run, 3 of 4 passes — 2 done, 1 reworked' }),
    ).toBeInTheDocument();

    // Usage opens by harness, named as people know them, with each one's cost.
    expect(screen.getByRole('tab', { name: 'Harness', selected: true })).toBeInTheDocument();
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('≈ $2.50')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Model' }));
    expect(await screen.findByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText('Model not reported')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Role' }));
    expect(await screen.findByText('Outside a card run')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Session' }));
    expect(await screen.findByText('Fix login flow')).toBeInTheDocument();
    expect(screen.getByText('Untitled session')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    // The Factory split only means something across Factories.
    expect(screen.queryByRole('tab', { name: 'Factory' })).not.toBeInTheDocument();
  });

  it('asks every widget again for another preset, and usage for every Factory', async () => {
    const asked = stub();
    const user = userEvent.setup();
    const { router } = renderRoute();

    await user.click(await screen.findByRole('button', { name: 'Date range: Last 30 days' }));
    await user.click(await screen.findByRole('menuitem', { name: /Last 7 days/ }));

    const week = rangeWindow(7);
    await waitFor(() => expect(asked.metrics.at(-1)).toEqual(week));
    await waitFor(() => expect(asked.usage.at(-1)).toEqual({ ...week, factoryProjectId: FACTORY_ID }));
    expect(router.state.location.search).toBe('?range=7');
    expect(screen.getByRole('button', { name: 'Date range: Last 7 days' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'All Factories' }));
    await waitFor(() => expect(asked.usage.at(-1)).toEqual(week));
    expect(screen.getByText(/Work counts this Factory’s board/)).toBeInTheDocument();
    await user.click(await screen.findByRole('tab', { name: 'Factory' }));
    expect(await within(screen.getByRole('tabpanel', { name: 'Factory' })).findByText('Acme Factory')).toBeInTheDocument();
  });

  it('opens on the window a link names', async () => {
    const asked = stub();
    renderRoute(`${SECTION}?range=365&scope=all`);

    expect(await screen.findByRole('button', { name: 'Date range: Last 12 months' })).toBeInTheDocument();
    await waitFor(() => expect(asked.usage.at(-1)).toEqual(rangeWindow(365)));
    expect(asked.metrics.at(-1)).toEqual(rangeWindow(365));
  });

  it('starts a new Factory from the board', async () => {
    stub({ metrics: quietMetrics(), usage: zero() });
    renderRoute();

    const empty = await screen.findByTestId('analytics-empty-state');
    expect(within(empty).getByRole('heading', { name: 'Your analytics start here' })).toBeInTheDocument();
    expect(within(empty).getByRole('link', { name: 'Open board' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/work`,
    );
    expect(within(empty).queryByRole('button', { name: 'Show the last 12 months' })).not.toBeInTheDocument();
    // Each widget shows the outline of what it will draw.
    expect(await screen.findByText('Nothing in flight')).toBeInTheDocument();
    expect(screen.getByText('No usage')).toBeInTheDocument();
  });

  it('suggests a wider range when work happened before the window', async () => {
    const asked = stub({
      metrics: quietMetrics(),
      usage: zero(),
      workItems: [card('item-1', { execute: { sessionId: 's-1', branch: 'b', threadId: 't', startedBy: 'user-1' } })],
    });
    const user = userEvent.setup();
    renderRoute();

    const empty = await screen.findByTestId('analytics-empty-state');
    expect(
      await within(empty).findByRole('heading', { name: 'Nothing happened in the last 30 days' }),
    ).toBeInTheDocument();
    await user.click(within(empty).getByRole('button', { name: 'Show the last 12 months' }));
    await waitFor(() => expect(asked.metrics.at(-1)).toEqual(rangeWindow(365)));
  });

  it.each(['analytics', 'metrics', 'overview', 'settings/usage'])(
    'opens the Analytics settings section from the old /%s link, keeping its window',
    async path => {
      stub();
      const { router } = renderRoute(`/factories/${FACTORY_ID}/${path}?range=7`);
      await waitFor(() => expect(router.state.location.pathname).toBe(SECTION));
      expect(router.state.location.search).toBe('?range=7');
      expect(await screen.findByRole('heading', { name: 'Analytics', level: 1 })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Date range: Last 7 days' })).toBeInTheDocument();
    },
  );

  it('summarizes every harness’s sign-ins in a Limits card each, closest to a limit first', async () => {
    stub();
    const refreshes: string[] = [];
    const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000 + 30_000).toISOString();
    const checkedAt = new Date().toISOString();
    server.use(
      http.get(`${TEST_BASE_URL}/web/usage/limits`, ({ request }) => {
        refreshes.push(new URL(request.url).searchParams.get('refresh') ?? '');
        return HttpResponse.json({
          accounts: [
            {
              accountId: 'acc-1',
              label: 'alice@example.com',
              harnessId: 'claude-code',
              harnessName: 'Claude Code',
              provider: 'anthropic',
              disabled: false,
              usage: {
                checkedAt,
                source: 'probe',
                windows: [
                  { id: 'five_hour', kind: 'session', usedPercent: 22, resetsAt: inHours(4) },
                  { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 50 },
                ],
              },
            },
            {
              accountId: 'acc-2',
              label: 'codex@example.com',
              harnessId: 'codex',
              harnessName: 'Codex',
              provider: 'openai-codex',
              disabled: true,
              usage: {
                checkedAt,
                source: 'stream',
                windows: [
                  { id: 'primary', kind: 'session', usedPercent: 88, resetsAt: inHours(1) },
                  { id: 'secondary', kind: 'weekly', usedPercent: 40, resetsAt: inHours(100) },
                ],
              },
            },
          ],
        } satisfies UsageLimitsResponse);
      }),
    );
    renderRoute();

    expect(await screen.findByRole('heading', { name: 'Limits' })).toBeInTheDocument();
    const groups = await screen.findAllByRole('group', { name: /^Usage of / });
    // Codex is at 88 % of its 5-hour window, Claude at most at 50 %: Codex first.
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Usage of codex@example.com', 'Usage of alice@example.com']);
    const codex = within(groups[0]!).getAllByRole('meter');
    expect(codex.map(meter => [meter.getAttribute('aria-label'), meter.getAttribute('data-level')])).toEqual([
      ['5-hour', 'warning'],
      ['Weekly', 'ok'],
    ]);
    expect(within(groups[0]!).getByText(/^resets in 1h 0m · /)).toBeInTheDocument();
    expect(screen.getByText('Codex · turned off')).toBeInTheDocument();
    expect(within(groups[1]!).getAllByRole('meter').map(meter => meter.getAttribute('aria-label'))).toEqual(['5-hour', 'Weekly · Opus']);
    expect(refreshes).toEqual(['1']);
  });

  it('says when no sign-in reports limits', async () => {
    stub();
    renderRoute();
    expect(await screen.findByText(/No sign-in reports limits yet/)).toBeInTheDocument();
  });

  it('is a Settings section, not a Factory sidebar entry', async () => {
    stub();
    const { router } = renderRoute(`/factories/${FACTORY_ID}/settings/preferences`);
    const link = await screen.findByRole('link', { name: 'Analytics' });
    expect(link).toHaveAttribute('href', SECTION);

    await router.navigate(`/factories/${FACTORY_ID}/work`);
    await screen.findByRole('region', { name: 'Boards' });
    expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
  });
});
