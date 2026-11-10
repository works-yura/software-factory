import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { AuditDomain } from '@factory/feed';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { createBoardRegistry, createFactoryStorageForTests, FactoryTransitionService } from '@factory/testing';

import { setupIntakeRules } from './index.ts';
import { IntakeConfigError } from './kinds.ts';
import type { IntakeTriggerKind } from './kinds.ts';
import { IntakeRuleRoutes } from './routes.ts';
import { intakeRuleScheduleId } from './schedule-trigger.ts';
import type { ScheduleRows } from './schedule-trigger.ts';

const ADMIN = 'admin-user';
const MEMBER = 'member-user';

const scheduleRule = {
  name: 'Security audit',
  trigger: { kind: 'schedule', config: { spec: { preset: 'weekdays', time: '14:18' }, timezone: 'Europe/Kyiv' } },
  action: {
    kind: 'create-card',
    config: { boardKey: 'audits', phaseKey: 'analysis', titleTemplate: 'Аудит — {date}', description: 'Аудит: security', repository: null },
  },
};

async function setup() {
  const seed = await createFactoryStorageForTests();
  const orgId = 'org-1';
  const project = await seed.projects.create({ orgId, userId: ADMIN, input: { name: 'Syncta' } });
  const boards = createBoardRegistry();
  const rows = new Map<string, Record<string, unknown>>();
  const schedules = {
    get: async (id: string) => (rows.get(id) as never) ?? null,
    create: async (input: Record<string, unknown>) => (rows.set(input.id as string, { ...input, status: 'active' }), input) as never,
    update: async (id: string, patch: Record<string, unknown>) => (rows.set(id, { ...rows.get(id), ...patch }), patch) as never,
    pause: async () => ({}) as never,
    resume: async () => ({}) as never,
    delete: async (id: string) => void rows.delete(id),
  } satisfies ScheduleRows;
  const echo: IntakeTriggerKind<{ word: string }> = {
    kind: 'test-echo',
    label: { uk: 'Луна', en: 'Echo' },
    parse: config => {
      const word = (config as { word?: unknown }).word;
      if (typeof word !== 'string') throw new IntakeConfigError('word is required');
      return { word };
    },
    describe: (config, locale) => (locale === 'uk' ? `Луна «${config.word}»` : `Echo "${config.word}"`),
    start: () => {},
    arm: async () => {},
    disarm: async () => {},
  };
  const { engine } = setupIntakeRules({
    rules: seed.intakeRules,
    now: () => new Date('2026-11-16T06:00:00Z'),
    logger: { warn: () => {} },
    schedule: { schedules: () => schedules },
    cards: {
      workItems: seed.workItems,
      boards: { load: async () => boards },
      transitionService: () => new FactoryTransitionService({ storage: seed.workItems, configVersion: 't', boards }),
      auditRecorder: { record: async () => null },
    },
    extra: { triggers: [echo] },
  });
  const auth = fakeRouteAuth({ isOrganizationAdmin: async (_org, userId) => userId === ADMIN });
  const audit = new AuditDomain({ auth, audit: seed.audit, projects: seed.projects });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: c.req.header('x-user') ?? ADMIN, organizationId: orgId } as never);
    await next();
  });
  mountApiRoutes(app, new IntakeRuleRoutes({ auth, audit, projects: seed.projects, storage: seed.intakeRules, engine }).routes());
  const base = `/web/factory/projects/${project.id}/intake-rules`;
  const send = async (method: string, path: string, body?: unknown, user = ADMIN) => {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': user },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { send, base, rows, seed };
}

describe('intake rule routes', () => {
  it('lists the kinds this server can run, with their labels and the template placeholders', async () => {
    const { send, base } = await setup();
    const { status, body } = await send('GET', `${base}/kinds?locale=uk`);
    expect(status).toBe(200);
    expect(body.triggers).toEqual([
      { kind: 'schedule', label: 'За розкладом' },
      { kind: 'test-echo', label: 'Луна' },
    ]);
    expect(body.actions).toEqual([{ kind: 'create-card', label: 'Створити картку' }]);
    expect(body.policies.map((policy: { kind: string }) => policy.kind)).toEqual(['skip-if-open', 'always']);
    expect(body.placeholders).toContain('{date}');
  });

  it('creates, pauses and deletes a rule, arming its schedule and auditing each change', async () => {
    const { send, base, rows, seed } = await setup();
    const created = await send('POST', `${base}?locale=uk`, scheduleRule);
    expect(created.status).toBe(201);
    const rule = created.body.intakeRule;
    expect(rule).toMatchObject({
      name: 'Security audit',
      trigger: { kind: 'schedule', summary: 'У будні о 14:18 (Europe/Kyiv)' },
      action: { kind: 'create-card', summary: 'Картка «Аудит — {date}» на audits › analysis' },
      policy: { kind: 'skip-if-open' },
      enabled: true,
      revision: 1,
      nextFires: ['2026-11-16T12:18:00.000Z', '2026-11-17T12:18:00.000Z', '2026-11-18T12:18:00.000Z'],
      lastFire: null,
      problems: [],
    });
    expect(rows.has(intakeRuleScheduleId(rule.id))).toBe(true);

    const paused = await send('PATCH', `${base}/${rule.id}`, { enabled: false, expectedRevision: 1 });
    expect(paused.status).toBe(200);
    expect(paused.body.intakeRule).toMatchObject({ enabled: false, revision: 2, nextFires: [] });
    expect(rows.has(intakeRuleScheduleId(rule.id))).toBe(false);

    expect((await send('PATCH', `${base}/${rule.id}`, { enabled: true, expectedRevision: 1 })).status).toBe(409);
    expect((await send('GET', `${base}/${rule.id}/fires`)).body).toEqual({ fires: [] });

    expect((await send('DELETE', `${base}/${rule.id}?expectedRevision=2`)).status).toBe(204);
    expect((await send('GET', base)).body).toEqual({ intakeRules: [] });

    const actions = (await seed.audit.list({ orgId: 'org-1' })).events.map(row => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['factory.intake_rule.created', 'factory.intake_rule.updated', 'factory.intake_rule.deleted']),
    );
  });

  it('refuses unknown kinds, configs that do not fit their kind, targets that cannot take cards, and non-admins', async () => {
    const { send, base } = await setup();
    const refused = async (body: unknown, user = ADMIN) => send('POST', base, body, user);
    expect((await refused({ ...scheduleRule, trigger: { kind: 'nope', config: {} } })).body.message).toMatch(/Unknown trigger/);
    expect(
      (await refused({ ...scheduleRule, trigger: { kind: 'schedule', config: { spec: { preset: 'daily', time: '9' }, timezone: 'UTC' } } }))
        .body.message,
    ).toMatch(/HH:MM/);
    expect(
      (await refused({ ...scheduleRule, action: { kind: 'create-card', config: { ...scheduleRule.action.config, boardKey: 'gone' } } }))
        .body.message,
    ).toMatch(/not installed/);
    expect(
      (await refused({ ...scheduleRule, action: { kind: 'create-card', config: { ...scheduleRule.action.config, phaseKey: 'done' } } }))
        .body.message,
    ).toMatch(/terminal/);
    expect((await refused(scheduleRule, MEMBER)).status).toBe(403);
    expect((await refused({ ...scheduleRule, trigger: { kind: 'test-echo', config: {} } })).body.message).toMatch(/word is required/);
  });

  it('accepts a rule of a registered extra trigger kind through the same routes', async () => {
    const { send, base } = await setup();
    const created = await send('POST', `${base}?locale=en`, { ...scheduleRule, trigger: { kind: 'test-echo', config: { word: 'hi' } } });
    expect(created.status).toBe(201);
    expect(created.body.intakeRule).toMatchObject({ trigger: { kind: 'test-echo', summary: 'Echo "hi"' }, nextFires: [] });
  });

  it('previews a schedule before it is saved', async () => {
    const { send, base } = await setup();
    const preview = await send('POST', `${base}/preview`, { trigger: scheduleRule.trigger, locale: 'en' });
    expect(preview.body).toMatchObject({ summary: 'Weekdays at 14:18 (Europe/Kyiv)', problems: [] });
    expect(preview.body.nextFires).toHaveLength(3);
  });
});
