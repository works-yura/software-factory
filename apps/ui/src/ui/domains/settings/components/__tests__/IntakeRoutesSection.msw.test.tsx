import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { IntakeRouteInfo } from '../../../../../api/types';
import { IntakeRoutesSection } from '../IntakeRoutesSection';

const PROJECT = 'proj-1';
const ROUTES_URL = `${TEST_BASE_URL}/web/factory/projects/${PROJECT}/intake-routes`;

const workBoard = {
  id: 'work',
  name: 'Work',
  title: 'Work',
  initialPhase: 'intake',
  phases: [
    { id: 'intake', name: 'Intake', title: 'Intake', kind: 'resting' },
    { id: 'triage', name: 'Triage', title: 'Triage', kind: 'working' },
    { id: 'done', name: 'Done', title: 'Done', kind: 'terminal' },
  ],
};

function route(overrides: Partial<IntakeRouteInfo> & Pick<IntakeRouteInfo, 'id' | 'name'>): IntakeRouteInfo {
  return {
    enabled: true,
    position: 0,
    when: null,
    target: { boardKey: 'work', phaseKey: null, joinClosedIssue: false },
    on: ['work_item.created'],
    revision: 1,
    createdBy: 'admin',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-11-04T00:00:00.000Z',
    problems: [],
    triggered: null,
    origin: null,
    ...overrides,
  };
}

const outsideAuthors = route({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Outside authors wait in Intake',
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'github' },
      { field: 'author.trusted', operator: 'equals', value: false },
    ],
  },
  target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
});
const clickUpTriage = route({
  id: '00000000-0000-4000-8000-000000000002',
  name: 'ClickUp to Triage',
  position: 1,
  when: { operator: 'AND', conditions: [{ field: 'source.integration', operator: 'equals', value: 'clickup' }] },
  target: { boardKey: 'work', phaseKey: 'triage', joinClosedIssue: false },
});

/**
 * The sources the Factory uses, behind the real API paths: its linked repositories' hosts and the
 * org's ClickUp connection.
 */
function useConnections({ hosts = ['github'], clickUp = true }: { hosts?: string[]; clickUp?: boolean } = {}) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: PROJECT,
            name: 'Acme',
            repositories: hosts.map((host, at) => ({
              projectRepositoryId: `repo-${at}`,
              integrationId: host,
              slug: `acme/app-${host}`,
              sandboxWorkdir: `app-${host}`,
            })),
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json(
        clickUp
          ? { configured: true, connected: true, workspaces: ['Acme'], intervalSeconds: 60 }
          : { configured: false, connected: false, workspaces: [], intervalSeconds: 60 },
      ),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/lists`, () => HttpResponse.json({ lists: [] })),
  );
}

/** A project's routes behind the real API paths; returns what the UI wrote. */
function useRouteHandlers(
  initial: IntakeRouteInfo[],
  { canEdit = true, hosts, clickUp }: { canEdit?: boolean; hosts?: string[]; clickUp?: boolean } = {},
) {
  useConnections({ hosts, clickUp });
  let routes = [...initial];
  const written = { created: [] as unknown[], patched: [] as unknown[], deleted: [] as string[], reordered: [] as string[][] };
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [workBoard] })),
    http.get(ROUTES_URL, () => HttpResponse.json({ intakeRoutes: routes, canEdit })),
    http.post(ROUTES_URL, async ({ request }) => {
      const body = (await request.json()) as Pick<IntakeRouteInfo, 'name' | 'enabled' | 'when' | 'target'>;
      written.created.push(body);
      const created = route({ id: '00000000-0000-4000-8000-000000000009', position: routes.length, ...body });
      routes = [...routes, created];
      return HttpResponse.json({ intakeRoute: created });
    }),
    http.patch(`${ROUTES_URL}/:routeId`, async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      written.patched.push({ id: params.routeId, ...body });
      routes = routes.map(entry => (entry.id === params.routeId ? { ...entry, ...body, revision: entry.revision + 1 } : entry));
      return HttpResponse.json({ intakeRoute: routes.find(entry => entry.id === params.routeId) });
    }),
    http.delete(`${ROUTES_URL}/:routeId`, ({ params, request }) => {
      written.deleted.push(`${String(params.routeId)}@${new URL(request.url).searchParams.get('expectedRevision')}`);
      routes = routes.filter(entry => entry.id !== params.routeId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${ROUTES_URL}/reorder`, async ({ request }) => {
      const { ids } = (await request.json()) as { ids: string[] };
      written.reordered.push(ids);
      routes = ids.map((id, position) => ({ ...routes.find(entry => entry.id === id)!, position }));
      return HttpResponse.json({ intakeRoutes: routes, canEdit });
    }),
  );
  return written;
}

function renderSection() {
  return renderWithProviders(
    <>
      <IntakeRoutesSection factoryProjectId={PROJECT} factoryName="Acme" />
      <Toaster />
    </>,
  );
}

const routeRows = () => within(screen.getByRole('list', { name: /intake routes/i })).getAllByRole('listitem');

describe('IntakeRoutesSection', () => {
  it('lists the routes in the order they are tried, each with what it matches and where it sends cards', async () => {
    useRouteHandlers([outsideAuthors, clickUpTriage]);
    renderSection();

    await waitFor(() => expect(routeRows()).toHaveLength(2));
    const [first, second] = routeRows();
    expect(within(first!).getByText('Outside authors wait in Intake')).toBeTruthy();
    expect(
      await within(first!).findByText('When: GitHub · outside author · new issue or pull request → Development › Intake'),
    ).toBeTruthy();
    expect(within(second!).getByText('When: ClickUp · new task → Development › Triage')).toBeTruthy();
  });

  it('offers in «When» only the sources the Factory uses, with no combined «GitHub or GitLab»', async () => {
    const user = userEvent.setup();
    useRouteHandlers([], { hosts: ['github'], clickUp: false });
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await waitFor(async () => {
      await user.click(within(form).getByRole('combobox', { name: 'When' }));
      const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
      expect(offered).toEqual(['Any source', 'GitHub', 'By hand (“New card”)']);
      await user.keyboard('{Escape}');
    });
  });

  it('keeps a route on a source the Factory no longer uses, marked «not connected», and saves it unchanged', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([clickUpTriage], { clickUp: false });
    renderSection();

    expect(await screen.findByText('When: ClickUp (not connected) · new task → Development › Triage')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit route "ClickUp to Triage"' });
    expect(within(form).getByRole('combobox', { name: 'When' })).toHaveTextContent('ClickUp');
    expect(within(form).getByText('not connected')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.patched).toHaveLength(1));
    expect(written.patched[0]).toMatchObject({ when: clickUpTriage.when, on: ['work_item.created'] });
  });

  it('adds a route for ClickUp tasks with a tag: the source is chosen once, in «When», and only its fields are offered', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Docs tasks to Triage');
    await user.click(within(form).getByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'ClickUp' }));
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    // ClickUp's own fields only: no source, no repository, no pull request kind.
    const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
    expect(offered).toEqual(['List', 'Status', 'Tag', 'Assignee', 'Title']);
    await user.click(screen.getByRole('option', { name: 'Tag' }));
    await user.type(within(form).getByRole('textbox', { name: 'Tag' }), 'docs');
    await user.click(within(form).getByRole('combobox', { name: 'Route board' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await user.click(within(form).getByRole('combobox', { name: 'Route phase' }));
    // A new card can't land in a terminal phase.
    expect(screen.queryByRole('option', { name: 'Done' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Triage' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toEqual({
      name: 'Docs tasks to Triage',
      enabled: true,
      on: ['work_item.created'],
      when: {
        operator: 'AND',
        conditions: [
          { field: 'source.integration', operator: 'equals', value: 'clickup' },
          { field: 'item.labels', operator: 'contains', value: 'docs' },
        ],
      },
      target: { boardKey: 'work', phaseKey: 'triage', joinClosedIssue: false },
    });
    await waitFor(() => expect(routeRows()).toHaveLength(1));
  });

  it('offers a GitHub route its repository, kind and author, and its pull request events', async () => {
    const user = userEvent.setup();
    useRouteHandlers([]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.click(within(form).getByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'GitHub' }));
    const events = within(within(form).getByRole('group', { name: 'Event' }));
    expect(events.getByRole('button', { name: 'new issue or pull request' })).toHaveAttribute('aria-pressed', 'true');
    expect(events.getByRole('button', { name: 'pull request merged' })).toHaveAttribute('aria-pressed', 'false');
    expect(events.queryByRole('button', { name: 'task status changed' })).toBeNull();
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
    expect(offered).toEqual(expect.arrayContaining(['Repository', 'Kind', 'Author', 'Label']));
    expect(offered).not.toContain('List');
    expect(offered).not.toContain('Source');
  });

  it('opens an existing route on its own source and saves it unchanged', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit route "Outside authors wait in Intake"' });
    expect(within(form).getByRole('combobox', { name: 'When' })).toHaveTextContent(/^GitHub$/);
    expect(within(form).queryByRole('group', { name: 'Source' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.patched).toHaveLength(1));
    expect(written.patched[0]).toMatchObject({ when: outsideAuthors.when, on: ['work_item.created'] });
  });

  it('adds a route «За розкладом» from the same editor: schedule, card and policy, on its own board', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([]);
    server.use(
      http.get(`${ROUTES_URL}/kinds`, () =>
        HttpResponse.json({
          triggers: [{ kind: 'schedule', label: 'On a schedule (repeats)' }],
          actions: [{ kind: 'create-card', label: 'Create a card' }],
          policies: [
            { kind: 'skip-if-open', label: 'Skip while the last card is open' },
            { kind: 'always', label: 'Always run' },
          ],
          placeholders: ['{date}', '{time}', '{route}'],
        }),
      ),
      http.post(`${ROUTES_URL}/preview`, () =>
        HttpResponse.json({ summary: 'Every Monday at 09:00 (Europe/Kyiv)', nextFires: ['2026-11-16T07:00:00.000Z'], problems: [] }),
      ),
    );
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Security audit');
    await user.click(await within(form).findByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'On a schedule (repeats)' }));
    // No conditions on a route that files its own cards.
    expect(within(form).queryByRole('combobox', { name: 'Add condition' })).toBeNull();
    await user.type(within(form).getByRole('textbox', { name: 'Card title' }), 'Аудит безпеки — {{date}');
    await user.click(within(form).getByRole('combobox', { name: 'Route board' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({
      name: 'Security audit',
      when: null,
      target: { boardKey: 'work' },
      triggered: {
        trigger: { kind: 'schedule' },
        action: { kind: 'create-card', config: { titleTemplate: 'Аудит безпеки — {date}' } },
        policy: { kind: 'skip-if-open' },
      },
    });
    expect(written.created[0]).not.toHaveProperty('on');
  });

  it('turns a route off, moves it, and deletes it only after a second click', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, clickUpTriage]);
    renderSection();

    await user.click(await screen.findByRole('switch', { name: 'Route "Outside authors wait in Intake" enabled' }));
    await waitFor(() =>
      expect(written.patched).toEqual([{ id: outsideAuthors.id, enabled: false, expectedRevision: 1 }]),
    );

    await user.click(screen.getByRole('button', { name: 'Move "ClickUp to Triage" up' }));
    await waitFor(() => expect(written.reordered).toEqual([[clickUpTriage.id, outsideAuthors.id]]));
    await waitFor(() => expect(within(routeRows()[0]!).getByText('ClickUp to Triage')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Delete route "ClickUp to Triage"' }));
    expect(written.deleted).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(written.deleted).toEqual([`${clickUpTriage.id}@1`]));
    await waitFor(() => expect(routeRows()).toHaveLength(1));
  });

  it("keeps a condition set through the API when only the route's name is edited", async () => {
    const user = userEvent.setup();
    const either = route({
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Docs or release',
      when: {
        operator: 'OR',
        conditions: [
          { field: 'item.labels', operator: 'contains', value: 'docs' },
          { field: 'item.labels', operator: 'contains', value: 'release' },
        ],
      },
    });
    const written = useRouteHandlers([either]);
    renderSection();

    expect(await screen.findByText('When: a condition set through the API → Development › first phase')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit route "Docs or release"' });
    expect(within(form).getByText(/set through the API and can't be changed here/)).toBeTruthy();
    const name = within(form).getByRole('textbox', { name: 'Route name' });
    await user.clear(name);
    await user.type(name, 'Docs and release');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.patched).toHaveLength(1));
    expect(written.patched[0]).toMatchObject({ name: 'Docs and release', when: either.when, expectedRevision: 1 });
  });

  it('says which issue event a status route handles and why the issue closed', async () => {
    useRouteHandlers([
      route({
        id: '00000000-0000-4000-8000-000000000005',
        name: 'Issues closed as not planned go to Canceled',
        on: ['work_item.closed'],
        when: { operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'canceled' }] },
        target: { boardKey: 'work', phaseKey: 'done', joinClosedIssue: false },
      }),
      route({
        id: '00000000-0000-4000-8000-000000000006',
        name: 'Reopened issues go back to Intake',
        position: 1,
        on: ['work_item.reopened'],
        target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
      }),
    ]);
    renderSection();

    await waitFor(() => expect(routeRows()).toHaveLength(2));
    const [closed, reopened] = routeRows();
    expect(within(closed!).getByText('When: issue closed · as not planned → Development › Done')).toBeTruthy();
    expect(within(reopened!).getByText('When: issue reopened → Development › Intake')).toBeTruthy();
  });

  it("shows the routes read-only to someone who isn't an organization admin", async () => {
    useRouteHandlers([clickUpTriage], { canEdit: false });
    renderSection();

    expect(await screen.findByText('Only an organization admin can change these routes.')).toBeInTheDocument();
    expect(routeRows()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add route' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows why a route is skipped', async () => {
    useRouteHandlers([route({ id: '00000000-0000-4000-8000-000000000004', name: 'To Docs', problems: ['Board "docs" is not installed in this project.'] })]);
    renderSection();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Route skipped: Board "docs" is not installed in this project.',
    );
  });
});

describe('IntakeRoutesSection — ClickUp Lists and schedules', () => {
  const clickUpHandlers = () =>
    server.use(
      http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
        HttpResponse.json({ configured: true, connected: true, workspaces: ['Acme'], intervalSeconds: 60 }),
      ),
      http.get(`${TEST_BASE_URL}/web/clickup/lists`, () =>
        HttpResponse.json({ lists: [{ id: 'L1', name: 'Bugs', path: 'Syncta', workspaceId: 'w1' }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/clickup/lists/L1/statuses`, () =>
        HttpResponse.json({
          statuses: [
            { name: 'to do', type: 'open' },
            { name: 'dev fixed', type: 'custom' },
          ],
        }),
      ),
    );

  it('adds a route that imports a List’s tasks with a status and follows later status changes', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([]);
    clickUpHandlers();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Bugs to Triage');
    await user.click(within(form).getByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'ClickUp' }));
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    await user.click(await screen.findByRole('option', { name: 'List' }));
    await user.click(within(form).getByRole('combobox', { name: 'List' }));
    await user.click(await screen.findByRole('option', { name: 'Syncta / Bugs' }));
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    await user.click(await screen.findByRole('option', { name: 'Status' }));
    // The List's own statuses.
    await user.click(await within(form).findByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'to do' }));
    await user.click(within(within(form).getByRole('group', { name: 'Event' })).getByRole('button', { name: 'task status changed' }));
    await user.click(within(form).getByRole('combobox', { name: 'Route board' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({
      when: {
        operator: 'AND',
        conditions: [
          { field: 'source.integration', operator: 'equals', value: 'clickup' },
          { field: 'source.list', operator: 'equals', value: 'L1' },
          { field: 'item.state', operator: 'equals', value: 'to do' },
        ],
      },
      on: ['work_item.created', 'work_item.state_changed'],
    });
  });

  it('describes a List’s migrated status routes and tags a schedule’s route', async () => {
    useRouteHandlers([
      route({
        id: '00000000-0000-4000-8000-000000000021',
        name: 'ClickUp: статус «dev fixed»',
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.integration', operator: 'equals', value: 'clickup' },
            { field: 'source.list', operator: 'equals', value: 'L1' },
            { field: 'item.state', operator: 'equals', value: 'dev fixed' },
          ],
        },
        on: ['work_item.state_changed'],
        target: { boardKey: 'work', phaseKey: 'done', joinClosedIssue: false },
      }),
      route({
        id: '00000000-0000-4000-8000-000000000022',
        name: 'Security audit',
        position: 1,
        on: [],
        target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
        triggered: {
          trigger: { kind: 'schedule', config: {}, summary: 'Every Monday at 09:00 (Europe/Kyiv)' },
          action: { kind: 'create-card', config: {}, summary: 'Card "Аудит безпеки"' },
          policy: { kind: 'skip-if-open', summary: 'Skip while the last card is open' },
          nextFires: ['2026-11-16T07:00:00.000Z'],
          lastFire: null,
        },
      }),
    ]);
    clickUpHandlers();
    renderSection();

    await waitFor(() => expect(routeRows()).toHaveLength(2));
    const [list, schedule] = routeRows();
    expect(
      await within(list!).findByText('When: ClickUp · Syncta / Bugs · status “dev fixed” · task status changed → Development › Done'),
    ).toBeTruthy();
    expect(within(list!).queryByText('Schedule')).toBeNull();
    expect(within(schedule!).getByText('Schedule')).toBeTruthy();
    expect(within(schedule!).getByText(/^When: Every Monday at 09:00 \(Europe\/Kyiv\)/)).toBeTruthy();
  });

  it('names a status route Factory wrote in the reader’s language, and unfolds a schedule route’s fire history', async () => {
    const user = userEvent.setup();
    useRouteHandlers([
      route({
        id: '00000000-0000-4000-8000-000000000031',
        name: 'ClickUp status “to do”',
        origin: { kind: 'clickup-status', listId: 'L1', status: 'to do', generatedName: 'ClickUp status “to do”' },
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.integration', operator: 'equals', value: 'clickup' },
            { field: 'source.list', operator: 'equals', value: 'L1' },
            { field: 'item.state', operator: 'equals', value: 'to do' },
          ],
        },
      }),
      route({
        id: '00000000-0000-4000-8000-000000000032',
        name: 'Security audit',
        position: 1,
        on: [],
        triggered: {
          trigger: { kind: 'schedule', config: {}, summary: 'Daily at 09:00 (UTC)' },
          action: { kind: 'create-card', config: {}, summary: 'Card' },
          policy: { kind: 'skip-if-open', summary: 'Skip' },
          nextFires: [],
          lastFire: null,
        },
      }),
    ]);
    server.use(
      http.get(`${ROUTES_URL}/:routeId/fires`, () =>
        HttpResponse.json({
          fires: [
            { id: 'f2', firedAt: '2026-11-17T09:00:00.000Z', triggerKind: 'schedule', outcome: 'skipped', workItemId: null, reason: 'The last card is still open.' },
            { id: 'f1', firedAt: '2026-11-16T09:00:00.000Z', triggerKind: 'schedule', outcome: 'done', workItemId: 'card-1', reason: null },
          ],
        }),
      ),
    );
    clickUpHandlers();
    renderSection();

    await waitFor(() => expect(routeRows()).toHaveLength(2));
    const [status, schedule] = routeRows();
    expect(within(status!).getByText('ClickUp: status “to do”')).toBeTruthy();
    await user.click(within(schedule!).getByRole('button', { name: 'History' }));
    const history = await within(schedule!).findByRole('list', { name: 'Fire history of “Security audit”' });
    expect(await within(history).findByText(/The last card is still open/)).toBeTruthy();
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
  });
});
