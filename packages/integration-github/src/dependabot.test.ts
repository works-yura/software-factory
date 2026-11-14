import { describe, expect, it, vi } from 'vitest';

import { cardRuleFacts, createBoardRegistry, defineBoard, placeArrival } from '@factory/core';
import type { IntakeRoute, RuleGroup } from '@factory/core';
import { arrivalSourceFacts } from '@factory/store';

import {
  createDependabotSweep,
  DependabotAccessError,
  dependabotAccessError,
  DependabotStatusBoard,
  parseDependabotAlert,
} from './dependabot.ts';
import type { DependabotAlert } from './dependabot.ts';

const START = new Date('2026-11-14T10:00:00.000Z');
const REPO = { id: 42, fullName: 'acme/app', installationId: 7 };

function alert(overrides: Partial<DependabotAlert> = {}): DependabotAlert {
  return {
    number: 3,
    state: 'open',
    url: 'https://github.com/acme/app/security/dependabot/3',
    createdAt: '2026-11-14T11:00:00.000Z',
    updatedAt: '2026-11-14T11:00:00.000Z',
    severity: 'high',
    ecosystem: 'npm',
    package: 'lodash',
    manifestPath: 'package-lock.json',
    advisory: 'GHSA-xxxx-yyyy-zzzz',
    cve: 'CVE-2026-0001',
    summary: 'Prototype pollution',
    description: 'Details',
    fixedIn: '4.17.21',
    ...overrides,
  };
}

const board = (id: string) =>
  defineBoard({
    id,
    title: id === 'security' ? 'Security' : 'Work',
    initialPhase: 'intake',
    phases: {
      intake: { title: 'Intake', kind: 'resting', nextPhases: ['execute', 'done', 'canceled'] },
      execute: { title: 'Execute', kind: 'working', role: 'work', nextPhases: ['done', 'canceled'] },
      done: { title: 'Done', kind: 'terminal' },
      canceled: { title: 'Canceled', kind: 'terminal' },
    },
    sourceClosed: { completed: 'done', canceled: 'canceled' },
  });

const registry = createBoardRegistry({ boards: [board('work'), board('security')] });

const kind = (extra: RuleGroup['conditions'] = []): RuleGroup => ({
  operator: 'AND',
  conditions: [
    { field: 'source.integration', operator: 'equals', value: 'github' },
    { field: 'source.kind', operator: 'equals', value: 'dependabot_alert' },
    ...extra,
  ],
});

const alertRoute = (when: RuleGroup = kind(), phase: string | null = 'execute'): IntakeRoute => ({
  id: 'dependabot',
  enabled: true,
  when,
  target: { boardKey: 'security', phaseKey: phase },
  on: ['work_item.created'],
});
const catchAll: IntakeRoute = { id: 'all', enabled: true, when: null, target: { boardKey: 'work' }, on: ['work_item.created'] };

interface SetupOptions {
  alerts?: DependabotAlert[];
  closed?: DependabotAlert[];
  routes?: IntakeRoute[];
  enabled?: boolean;
  existing?: unknown;
  listError?: unknown;
}

function setup(options: SetupOptions = {}) {
  const listAlerts = vi.fn(async (input: { state: 'open' | 'closed' }) => {
    if (options.listError) throw options.listError;
    return input.state === 'open' ? (options.alerts ?? [alert()]) : (options.closed ?? []);
  });
  const commitRuleEvaluation = vi.fn(async (_input: unknown) => ({ status: 'committed', result: {} }));
  const update = vi.fn(async (_input: unknown) => null);
  const getByProjectSource = vi.fn(async (_input: unknown) => options.existing ?? null);
  const status = new DependabotStatusBoard();
  const sweep = createDependabotSweep({
    listAlerts: listAlerts as never,
    projectRepositories: {
      listByExternalRepository: async () => [{ orgId: 'org', factoryProjectId: 'proj', projectRepository: {} as never }],
    },
    intake: { getConfig: async () => ({ dependabot: { enabled: options.enabled ?? true, sourceIds: null } }) } as never,
    intakeRoutes: { listIntakeRoutes: async () => options.routes ?? [alertRoute(), catchAll] },
    projectBoards: { load: async () => registry },
    workItems: { getByProjectSource, commitRuleEvaluation, update } as never,
    configVersion: 'v',
    status,
    now: () => START,
  });
  return { sweep, listAlerts, commitRuleEvaluation, update, status };
}

const decisionOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0]![0] as any).decisions[0];

/** Where the dispatcher puts the filed arrival, with the facts it reads from the decision. */
function landing(decision: any, routes: IntakeRoute[]) {
  const source = { integrationId: 'github', type: 'dependabot-alert', externalId: decision.sourceKey, url: decision.url };
  const workItem = arrivalSourceFacts(source, decision.metadata);
  const facts = cardRuleFacts({
    title: decision.title,
    metadata: decision.metadata,
    externalSource: source,
    ...(workItem ? { workItem } : {}),
  });
  return { facts, placed: placeArrival(routes, facts, registry, decision.routing) };
}

describe('Dependabot sweep', () => {
  it('files an open alert a route takes as a card, and the route places it', async () => {
    const { sweep, commitRuleEvaluation, status } = setup();
    const summary = await sweep([REPO]);

    expect(summary).toMatchObject({ repositories: 1, created: 1, failed: 0 });
    const decision = decisionOf(commitRuleEvaluation);
    expect(decision).toMatchObject({
      type: 'upsertLinkedWorkItem',
      source: 'github-dependabot-alert',
      sourceKey: '42#3',
      title: 'lodash: Prototype pollution',
      url: 'https://github.com/acme/app/security/dependabot/3',
      routing: { skipCatchAll: true },
    });
    const { facts, placed } = landing(decision, [alertRoute(), catchAll]);
    expect(facts).toMatchObject({
      'source.kind': 'dependabot_alert',
      'source.repository': 'acme/app',
      'alert.severity': 'high',
      'alert.ecosystem': 'npm',
      'alert.package': 'lodash',
    });
    expect(placed).toEqual({ board: 'security', phase: 'execute', routeId: 'dependabot' });
    expect(status.forOrg('org')).toEqual([{ repository: 'acme/app', checkedAt: START.toISOString(), openAlerts: 1 }]);
  });

  it('holds an alert that was open before the server started at the first phase', async () => {
    const { sweep, commitRuleEvaluation } = setup({ alerts: [alert({ createdAt: '2026-11-01T00:00:00.000Z' })] });
    await sweep([REPO]);
    expect(decisionOf(commitRuleEvaluation).routing).toEqual({ skipCatchAll: true, holdAtInitialPhase: true });
  });

  it('files only the alerts a route condition takes (severity)', async () => {
    const routes = [
      alertRoute(kind([{ field: 'alert.severity', operator: 'in', value: ['critical', 'high'] }])),
      catchAll,
    ];
    const { sweep, commitRuleEvaluation } = setup({ routes, alerts: [alert({ severity: 'low' })] });
    const summary = await sweep([REPO]);
    expect(summary.created).toBe(0);
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('reads nothing while Dependabot intake is off', async () => {
    const { sweep, listAlerts } = setup({ enabled: false });
    expect(await sweep([REPO])).toMatchObject({ repositories: 0, created: 0 });
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it('reads nothing when no route takes alerts: the catch-all route does not subscribe a project', async () => {
    const { sweep, listAlerts } = setup({ routes: [catchAll] });
    await sweep([REPO]);
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it('says which permission is missing, per repository, instead of skipping quietly', async () => {
    const { sweep, status } = setup({
      listError: dependabotAccessError(Object.assign(new Error('Resource not accessible by integration'), { status: 403 }), 'acme/app'),
    });
    const summary = await sweep([REPO]);
    expect(summary.failed).toBe(1);
    expect(status.forOrg('org')).toEqual([
      expect.objectContaining({ repository: 'acme/app', problem: 'permission', message: expect.stringContaining('Dependabot alerts: read') }),
    ]);
  });

  it('finishes the card of a fixed alert and cancels the card of a dismissed one', async () => {
    const existing = {
      id: 'card-1',
      board: 'security',
      stages: ['execute'],
      revision: 4,
      metadata: {},
      workItem: { metadata: {} },
    };
    const fixed = setup({ alerts: [], closed: [alert({ state: 'fixed', updatedAt: '2026-11-14T12:00:00.000Z' })], existing });
    expect(await fixed.sweep([REPO])).toMatchObject({ closed: 1 });
    const fixedDecision = (fixed.commitRuleEvaluation.mock.calls.at(-1)![0] as any).decisions[0];
    expect(fixedDecision).toMatchObject({ type: 'transition', stage: 'done', event: { type: 'work_item.closed', reason: 'completed' } });

    const dismissed = setup({ alerts: [], closed: [alert({ state: 'dismissed' })], existing });
    await dismissed.sweep([REPO]);
    const dismissedDecision = (dismissed.commitRuleEvaluation.mock.calls.at(-1)![0] as any).decisions[0];
    expect(dismissedDecision).toMatchObject({ stage: 'canceled', event: { reason: 'canceled' } });
  });

  it('never files a card for a closed alert it has not seen', async () => {
    const { sweep, commitRuleEvaluation } = setup({ alerts: [], closed: [alert({ state: 'fixed' })] });
    await sweep([REPO]);
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
  });
});

describe('Dependabot alert payloads and refusals', () => {
  it('reads GitHub\'s alert JSON', () => {
    expect(
      parseDependabotAlert({
        number: 9,
        state: 'auto_dismissed',
        html_url: 'https://github.com/acme/app/security/dependabot/9',
        created_at: 'c',
        updated_at: 'u',
        dependency: { package: { ecosystem: 'pip', name: 'django' }, manifest_path: 'requirements.txt' },
        security_advisory: { ghsa_id: 'GHSA-1', cve_id: null, summary: 'SQLi', description: 'd', severity: 'critical' },
        security_vulnerability: { severity: 'critical', first_patched_version: { identifier: '5.0.1' } },
      }),
    ).toEqual({
      number: 9,
      state: 'auto_dismissed',
      url: 'https://github.com/acme/app/security/dependabot/9',
      createdAt: 'c',
      updatedAt: 'u',
      severity: 'critical',
      ecosystem: 'pip',
      package: 'django',
      manifestPath: 'requirements.txt',
      advisory: 'GHSA-1',
      cve: null,
      summary: 'SQLi',
      description: 'd',
      fixedIn: '5.0.1',
    });
    expect(parseDependabotAlert({ number: 1, state: 'weird', html_url: 'x' })).toBeUndefined();
  });

  it('names the refusal: missing permission, alerts switched off, repository not visible', () => {
    const refused = (status: number, message: string) =>
      dependabotAccessError(Object.assign(new Error(message), { status }), 'acme/app') as DependabotAccessError;
    expect(refused(403, 'Resource not accessible by integration').problem).toBe('permission');
    expect(refused(403, 'Dependabot alerts are disabled for this repository.').problem).toBe('disabled');
    expect(refused(404, 'Not Found').problem).toBe('not_found');
    const other = new Error('boom');
    expect(dependabotAccessError(other, 'acme/app')).toBe(other);
  });
});
