import { Input } from '@mastra/playground-ui/components/Input';
import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { IntakeRuleFireInfo, IntakeRuleInfo } from '../../../../../api/types';
import { registerIntakeTriggerForm } from '../formRegistry';
import { IntakeRulesSection } from '../IntakeRulesSection';

const PROJECT = 'proj-1';
const RULES_URL = `${TEST_BASE_URL}/web/factory/projects/${PROJECT}/intake-rules`;

const auditsBoard = {
  id: 'audits',
  name: 'Audits',
  title: 'Audits',
  initialPhase: 'intake',
  phases: [
    { id: 'intake', name: 'Intake', title: 'Intake', kind: 'resting' },
    { id: 'analysis', name: 'Analysis', title: 'Analysis', kind: 'working' },
    { id: 'done', name: 'Done', title: 'Done', kind: 'terminal' },
  ],
};

function rule(overrides: Partial<IntakeRuleInfo> = {}): IntakeRuleInfo {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Security audit',
    trigger: {
      kind: 'schedule',
      config: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' },
      summary: 'Every Monday at 08:00 (Europe/Kyiv)',
    },
    action: {
      kind: 'create-card',
      config: { boardKey: 'audits', phaseKey: 'analysis', titleTemplate: 'Security audit — {date}', description: '', repository: null },
      summary: 'Card "Security audit — {date}" on audits › analysis',
    },
    policy: { kind: 'skip-if-open', summary: 'Skip while the last card is open' },
    enabled: true,
    revision: 1,
    createdBy: 'admin',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-11-10T00:00:00.000Z',
    nextFires: ['2026-11-16T06:00:00.000Z'],
    lastFire: null,
    problems: [],
    ...overrides,
  };
}

const fires: IntakeRuleFireInfo[] = [
  { id: 'f2', firedAt: '2026-11-09T06:00:00.000Z', triggerKind: 'schedule', outcome: 'skipped', workItemId: null, reason: 'The card from the last fire is still open.' },
  { id: 'f1', firedAt: '2026-11-02T06:00:00.000Z', triggerKind: 'schedule', outcome: 'done', workItemId: 'card-1', reason: null },
];

function useHandlers(initial: IntakeRuleInfo[], extraTriggers: { kind: string; label: string }[] = []) {
  let rules = [...initial];
  const written = { created: [] as unknown[], patched: [] as unknown[], previews: [] as unknown[] };
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [auditsBoard] })),
    http.get(`${RULES_URL}/kinds`, () =>
      HttpResponse.json({
        triggers: [{ kind: 'schedule', label: 'On a schedule' }, ...extraTriggers],
        actions: [{ kind: 'create-card', label: 'Create a card' }],
        policies: [
          { kind: 'skip-if-open', label: 'Skip while the last card is open' },
          { kind: 'always', label: 'Always run' },
        ],
        placeholders: ['{date}', '{time}', '{rule}', '{payload.<key>}'],
      }),
    ),
    http.post(`${RULES_URL}/preview`, async ({ request }) => {
      const body = (await request.json()) as { trigger: { kind: string; config: Record<string, unknown> } };
      written.previews.push(body.trigger);
      return HttpResponse.json(
        body.trigger.kind === 'schedule'
          ? { summary: 'Weekdays at 09:00 (Europe/Kyiv)', nextFires: ['2026-11-16T07:00:00.000Z'], problems: [] }
          : { summary: `Echo ${String(body.trigger.config.word ?? '')}`, nextFires: [], problems: [] },
      );
    }),
    http.get(RULES_URL, () => HttpResponse.json({ intakeRules: rules })),
    http.post(RULES_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      written.created.push(body);
      const created = rule({ id: '00000000-0000-4000-8000-000000000009', name: String(body.name) });
      rules = [...rules, created];
      return HttpResponse.json({ intakeRule: created }, { status: 201 });
    }),
    http.patch(`${RULES_URL}/:ruleId`, async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      written.patched.push({ id: params.ruleId, ...body });
      rules = rules.map(entry => (entry.id === params.ruleId ? { ...entry, ...(body as object), revision: entry.revision + 1 } : entry));
      return HttpResponse.json({ intakeRule: rules.find(entry => entry.id === params.ruleId) });
    }),
    http.get(`${RULES_URL}/:ruleId/fires`, () => HttpResponse.json({ fires })),
  );
  return written;
}

function renderSection() {
  return renderWithProviders(
    <MemoryRouter>
      <IntakeRulesSection factoryProjectId={PROJECT} factoryName="Syncta" />
      <Toaster />
    </MemoryRouter>,
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

describe('IntakeRulesSection', () => {
  it('lists each rule with its trigger and action in words, its next run and last outcome', async () => {
    useHandlers([rule({ lastFire: fires[1]! })]);
    renderSection();
    const row = await screen.findByRole('listitem', { name: 'Security audit' });
    expect(within(row).getByText('Every Monday at 08:00 (Europe/Kyiv) → Card "Security audit — {date}" on audits › analysis')).toBeTruthy();
    expect(within(row).getByText(/Next run: .*· last: .*, done/)).toBeTruthy();
  });

  it('creates a scheduled rule filing Audits cards, previewing the schedule as it is set', async () => {
    const user = userEvent.setup();
    const written = useHandlers([]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const form = screen.getByRole('form', { name: 'New rule' });
    await user.type(within(form).getByRole('textbox', { name: 'Rule name' }), 'Weekly deps');
    const timezone = within(form).getByRole('textbox', { name: 'Timezone' });
    await user.clear(timezone);
    await user.type(timezone, 'Europe/Kyiv');
    await user.type(within(form).getByRole('textbox', { name: 'Card title' }), 'Dependencies — {{date}');
    await user.type(within(form).getByRole('textbox', { name: 'Card description' }), 'Audit: dependencies');
    expect(await within(form).findByText('Weekdays at 09:00 (Europe/Kyiv)')).toBeTruthy();
    expect(within(form).getByText(/Placeholders: \{date\}/)).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toEqual({
      name: 'Weekly deps',
      enabled: true,
      trigger: { kind: 'schedule', config: { spec: { preset: 'weekdays', time: '09:00' }, timezone: 'Europe/Kyiv' } },
      action: {
        kind: 'create-card',
        config: { boardKey: 'audits', phaseKey: 'analysis', titleTemplate: 'Dependencies — {date}', description: 'Audit: dependencies', repository: null },
      },
      policy: { kind: 'skip-if-open' },
    });
  });

  it('pauses a rule and shows its history: the card it filed and the fire it skipped', async () => {
    const user = userEvent.setup();
    const written = useHandlers([rule()]);
    renderSection();
    const row = await screen.findByRole('listitem', { name: 'Security audit' });

    await user.click(within(row).getByRole('switch', { name: 'Enabled: Security audit' }));
    await waitFor(() => expect(written.patched).toEqual([{ id: rule().id, enabled: false, expectedRevision: 1 }]));

    await user.click(within(row).getByRole('button', { name: 'History' }));
    const history = await within(row).findByRole('list', { name: 'History of Security audit' });
    expect(within(history).getByText('skipped')).toBeTruthy();
    expect(within(history).getByText('The card from the last fire is still open.')).toBeTruthy();
    expect(within(history).getByRole('link', { name: 'card' }).getAttribute('href')).toBe('/factories/proj-1/boards/audits?item=card-1');
  });

  it('edits a trigger kind the UI registered a form for, through the same editor', async () => {
    cleanups.push(
      registerIntakeTriggerForm({
        kind: 'test-echo',
        defaultConfig: () => ({ word: '' }),
        ready: config => typeof config.word === 'string' && config.word.length > 0,
        Form: ({ config, onChange, disabled }) => (
          <Input aria-label="Echo word" value={String(config.word ?? '')} disabled={disabled} onChange={event => onChange({ word: event.target.value })} />
        ),
      }),
    );
    const user = userEvent.setup();
    const written = useHandlers([], [{ kind: 'test-echo', label: 'Echo' }]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const form = screen.getByRole('form', { name: 'New rule' });
    await user.type(within(form).getByRole('textbox', { name: 'Rule name' }), 'Echo rule');
    await user.click(within(form).getByRole('combobox', { name: 'Trigger' }));
    await user.click(await screen.findByRole('option', { name: 'Echo' }));
    await user.type(within(form).getByRole('textbox', { name: 'Echo word' }), 'hi');
    expect(await within(form).findByText('Echo hi')).toBeTruthy();
    await user.type(within(form).getByRole('textbox', { name: 'Card title' }), 'Echoed');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({ trigger: { kind: 'test-echo', config: { word: 'hi' } } });
  });
});
