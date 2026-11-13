import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { IntakeRouteInfo } from '../../../../../api/types';
import { CardMovesSection, IntakeRoutesSection } from '../IntakeRoutesSection';

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
    // No kinds for a route «За розкладом» unless a test serves them.
    http.get(`${ROUTES_URL}/kinds`, () => HttpResponse.json({ triggers: [], actions: [], policies: [], placeholders: [] })),
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

/** Where the page went: a card opened from a run's toast lands on its board with `?item=`. */
function Location() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

function renderSection() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="*" element={<IntakeRoutesSection factoryProjectId={PROJECT} factoryName="Acme" />} />
      </Routes>
      <Location />
      <Toaster />
    </MemoryRouter>,
  );
}


const catchAll = route({
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Everything else goes to Work › Intake',
  position: 2,
  target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
});
const closedToDone = route({
  id: '00000000-0000-4000-8000-000000000004',
  name: 'Closed issues go to Done',
  position: 3,
  on: ['work_item.closed'],
  when: { operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'completed' }] },
  target: { boardKey: 'work', phaseKey: 'done', joinClosedIssue: false },
});

/** Adds one more condition to `group`, picking its value from the ones the field offers. */
async function addChoice(user: ReturnType<typeof userEvent.setup>, group: HTMLElement, field: string, value: string) {
  await user.click(within(group).getByRole('button', { name: 'Add condition' }));
  await user.click(within(group).getAllByRole('combobox', { name: 'Field' }).at(-1)!);
  await user.click(await screen.findByRole('option', { name: field }));
  // A yes-or-no fact is answered in place; any other offers its values in a list.
  if (value === 'Yes' || value === 'No') return user.click(within(group).getByRole('radio', { name: value }));
  await user.click(within(group).getAllByRole('combobox', { name: 'Value' }).at(-1)!);
  await user.click(await screen.findByRole('option', { name: value }));
}

const JOIN_SWITCH = 'Join the issue’s card instead';

const routeList = () => screen.getByRole('list', { name: 'Intake routes, in the order they are tried' });

describe('IntakeRoutesSection — where new cards go', () => {
  it('reads the new-card routes as an If / Else if / Otherwise chain, and leaves card moves to their boards', async () => {
    useRouteHandlers([outsideAuthors, clickUpTriage, catchAll, closedToDone]);
    renderSection();

    await screen.findByDisplayValue('Outside authors wait in Intake');
    const steps = within(routeList())
      .getAllByRole('listitem')
      .map(item => item.querySelector('[data-slot="rule-card-step"]')?.textContent);
    expect(steps).toEqual(['If', 'Else if', 'Otherwise']);
    // A route on an issue event moves cards already on its board: it lives on the board's Card moves page.
    expect(screen.queryByDisplayValue('Closed issues go to Done')).not.toBeInTheDocument();
    // The source a route names reads as «From», its other conditions as rows.
    const first = within(routeList()).getAllByRole('listitem')[0]!;
    expect(within(first).getByRole('combobox', { name: 'Source' })).toHaveTextContent('GitHub');
    expect(within(first).getByRole('radio', { name: 'Outside author' })).toBeChecked();
  });

  it('says where leftover cards land when no route takes every new card', async () => {
    useRouteHandlers([outsideAuthors]);
    renderSection();

    expect(await screen.findByText('Everything else goes to')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Board for new cards' })).toHaveTextContent('Development');
  });

  it('saves a rename on its own, with an Undo that puts the old name back', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, catchAll]);
    renderSection();

    const name = await screen.findByDisplayValue('Outside authors wait in Intake');
    await user.clear(name);
    await user.type(name, 'Strangers wait{Enter}');

    await waitFor(() =>
      expect(written.patched).toEqual([{ id: outsideAuthors.id, name: 'Strangers wait', expectedRevision: 1 }]),
    );
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(written.patched.at(-1)).toEqual({
        id: outsideAuthors.id,
        name: 'Outside authors wait in Intake',
        expectedRevision: 2,
      }),
    );
  });

  it('turns a route off from its switch', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, catchAll]);
    renderSection();

    await user.click(await screen.findByRole('switch', { name: 'Route "Outside authors wait in Intake" enabled' }));
    await waitFor(() => expect(written.patched).toEqual([{ id: outsideAuthors.id, enabled: false, expectedRevision: 1 }]));
  });

  it('saves a condition as soon as it is whole, keeping the route’s source', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, catchAll]);
    renderSection();

    const first = await waitFor(() => within(routeList()).getAllByRole('listitem')[0]!);
    await user.click(within(first).getByRole('radio', { name: 'Trusted' }));

    await waitFor(() =>
      expect(written.patched).toEqual([
        {
          id: outsideAuthors.id,
          when: {
            operator: 'AND',
            conditions: [
              { field: 'source.integration', operator: 'equals', value: 'github' },
              { field: 'author.trusted', operator: 'equals', value: true },
            ],
          },
          expectedRevision: 1,
        },
      ]),
    );
  });

  it('deletes a route at once, and Undo makes it again in its place', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, clickUpTriage, catchAll]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Outside authors wait in Intake actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(written.deleted).toEqual([`${outsideAuthors.id}@1`]));
    expect(screen.queryByDisplayValue('Outside authors wait in Intake')).not.toBeInTheDocument();
    expect(await screen.findByText('Deleted Outside authors wait in Intake')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({ name: 'Outside authors wait in Intake', when: outsideAuthors.when });
    await waitFor(() =>
      expect(written.reordered.at(-1)).toEqual([
        '00000000-0000-4000-8000-000000000009',
        clickUpTriage.id,
        catchAll.id,
      ]),
    );
  });

  it('adds a route only once it is named with a condition, on the source chosen in «From»', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([catchAll], { clickUp: true });
    server.use(
      http.get(`${TEST_BASE_URL}/web/clickup/lists`, () =>
        HttpResponse.json({ lists: [{ id: 'L1', name: 'Bugs', path: 'Syncta', workspaceId: 'w1' }] }),
      ),
    );
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const draft = screen.getByRole('group', { name: 'New route' });
    await user.type(within(draft).getByRole('textbox', { name: 'New route name' }), 'Syncta bugs');
    expect(within(draft).getByRole('button', { name: 'Add route' })).toBeDisabled();

    await user.click(within(draft).getByRole('combobox', { name: 'Source' }));
    await user.click(await screen.findByRole('option', { name: 'ClickUp' }));
    await user.click(within(draft).getByRole('button', { name: 'Add condition' }));
    await user.click(within(draft).getByRole('combobox', { name: 'Field' }));
    // Only the fields a ClickUp task has.
    expect(screen.queryByRole('option', { name: 'Author trust' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'ClickUp List' }));
    await user.click(within(draft).getByRole('combobox', { name: 'Value' }));
    await user.click(await screen.findByRole('option', { name: 'Syncta / Bugs' }));
    await user.click(within(draft).getByRole('button', { name: 'Add route' }));

    await waitFor(() =>
      expect(written.created).toEqual([
        {
          name: 'Syncta bugs',
          enabled: true,
          when: {
            operator: 'AND',
            conditions: [
              { field: 'source.integration', operator: 'equals', value: 'clickup' },
              { field: 'source.list', operator: 'equals', value: 'L1' },
            ],
          },
          target: { boardKey: 'work', phaseKey: 'intake' },
        },
      ]),
    );
  });

  it('picks a GitHub route’s repository from the project’s own, or takes a typed one', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([outsideAuthors, catchAll], { hosts: ['github', 'gitlab'] });
    renderSection();

    const first = await waitFor(() => within(routeList()).getAllByRole('listitem')[0]!);
    await user.click(within(first).getByRole('button', { name: 'Add condition' }));
    await user.click(within(first).getAllByRole('combobox', { name: 'Field' }).at(-1)!);
    await user.click(await screen.findByRole('option', { name: 'Repository or project' }));
    await user.click(within(first).getByRole('combobox', { name: 'Value' }));
    // The route names GitHub, so the GitLab project isn't offered.
    expect(screen.queryByRole('option', { name: 'acme/app-gitlab' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'acme/app-github' }));

    await waitFor(() =>
      expect(written.patched.at(-1)).toMatchObject({
        id: outsideAuthors.id,
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.integration', operator: 'equals', value: 'github' },
            { field: 'author.trusted', operator: 'equals', value: false },
            { field: 'source.repository', operator: 'equals', value: 'acme/app-github' },
          ],
        },
      }),
    );
  });

  it('warns that a bare repository name never matches a GitHub route', async () => {
    useRouteHandlers([
      route({
        ...outsideAuthors,
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.integration', operator: 'equals', value: 'github' },
            { field: 'source.repository', operator: 'equals', value: 'app' },
          ],
        },
      }),
      catchAll,
    ]);
    renderSection();

    expect(await screen.findByText('GitHub repositories are owner/repo, such as acme/app.')).toBeInTheDocument();
  });

  it("adds a route that joins a pull request to its issue's card, in any unfinished phase", async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([catchAll]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const draft = screen.getByRole('group', { name: 'New route' });
    await user.type(within(draft).getByRole('textbox', { name: 'New route name' }), 'Fixes join their issue');
    expect(within(draft).queryByRole('switch', { name: JOIN_SWITCH })).not.toBeInTheDocument();
    await addChoice(user, draft, 'Source kind', 'Pull request');
    await addChoice(user, draft, 'Pull request closes an issue', 'Yes');
    expect(within(draft).getByText('Send to')).toBeInTheDocument();
    await user.click(within(draft).getByRole('switch', { name: JOIN_SWITCH }));
    expect(within(draft).getByText('Join the issue’s card, move to')).toBeInTheDocument();

    await user.click(within(draft).getByRole('combobox', { name: 'Route phase' }));
    const phases = (await screen.findAllByRole('option')).map(option => option.textContent);
    expect(phases).toEqual(['Intake', 'Triage']);
    await user.click(screen.getByRole('option', { name: 'Triage' }));
    await user.click(within(draft).getByRole('button', { name: 'Add route' }));

    await waitFor(() =>
      expect(written.created).toEqual([
        {
          name: 'Fixes join their issue',
          enabled: true,
          when: {
            operator: 'AND',
            conditions: [
              { field: 'source.kind', operator: 'equals', value: 'pull_request' },
              { field: 'pullRequest.closesIssue', operator: 'equals', value: true },
            ],
          },
          target: { boardKey: 'work', phaseKey: 'triage', joinClosedIssue: true },
        },
      ]),
    );
  });

  it('turns joining off for a saved route, moving it to a phase new cards can land in', async () => {
    const user = userEvent.setup();
    const joins = route({
      id: '00000000-0000-4000-8000-000000000005',
      name: 'Fixes join their issue',
      when: {
        operator: 'AND',
        conditions: [
          { field: 'source.kind', operator: 'equals', value: 'pull_request' },
          { field: 'pullRequest.closesIssue', operator: 'equals', value: true },
        ],
      },
      target: { boardKey: 'work', phaseKey: 'triage', joinClosedIssue: true },
    });
    const written = useRouteHandlers([joins, catchAll]);
    renderSection();

    const toggle = await screen.findByRole('switch', { name: JOIN_SWITCH });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Join the issue’s card, move to')).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() =>
      expect(written.patched).toEqual([
        {
          id: joins.id,
          // Triage holds joined cards; a new card only lands in Intake, which leads nowhere on this board.
          target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
          expectedRevision: 1,
        },
      ]),
    );
  });

  it("shows the routes read-only to someone who isn't an organization admin", async () => {
    useRouteHandlers([outsideAuthors, catchAll], { canEdit: false });
    renderSection();

    expect(await screen.findByText('Only an organization admin can change these routes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add route' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /actions$/ })).not.toBeInTheDocument();
    expect(screen.getByText('Outside authors wait in Intake')).toBeInTheDocument();
  });

  it('shows why a route is skipped', async () => {
    useRouteHandlers([route({ ...outsideAuthors, problems: ['board "gone" is not installed'] }), catchAll]);
    renderSection();

    expect(await screen.findByText('Route skipped: board "gone" is not installed')).toBeInTheDocument();
  });
});

describe('CardMovesSection', () => {
  function renderMoves() {
    return renderWithProviders(
      <MemoryRouter initialEntries={['/moves']}>
        <CardMovesSection factoryId={PROJECT} boardId="work" />
        <Toaster />
      </MemoryRouter>,
    );
  }

  it("lists only this board's card moves, each as When › Where › Move to", async () => {
    useRouteHandlers([outsideAuthors, catchAll, closedToDone]);
    renderMoves();

    expect(await screen.findByDisplayValue('Closed issues go to Done')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Outside authors wait in Intake')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'When' })).toHaveTextContent('A card is closed');
    expect(screen.getByRole('combobox', { name: 'Move to' })).toHaveTextContent('Done');
  });

  it('changes the event a move waits for', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([closedToDone]);
    renderMoves();

    await user.click(await screen.findByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'A card is reopened' }));
    await waitFor(() => expect(written.patched).toEqual([{ id: closedToDone.id, on: ['work_item.reopened'], expectedRevision: 1 }]));
  });
});

describe('IntakeRoutesSection — running a route «За розкладом» now', () => {
  const ROUTE_ID = '00000000-0000-4000-8000-000000000041';
  const scheduleRoute = (overrides: Partial<IntakeRouteInfo> = {}) =>
    route({
      id: ROUTE_ID,
      name: 'Security audit',
      on: [],
      target: { boardKey: 'work', phaseKey: 'intake', joinClosedIssue: false },
      triggered: {
        trigger: { kind: 'schedule', config: { spec: { preset: 'daily', time: '09:00' }, timezone: 'UTC' }, summary: 'Daily at 09:00 (UTC)' },
        action: { kind: 'create-card', config: { titleTemplate: 'Audit {date}', description: '', repository: null }, summary: 'Card' },
        policy: { kind: 'skip-if-open', summary: 'Skip while the last card is open' },
        nextFires: [],
        lastFire: null,
      },
      ...overrides,
    });
  const fireOf = (overrides: Record<string, unknown>) => ({
    id: 'fire-1',
    firedAt: '2026-11-18T13:05:00.000Z',
    triggerKind: 'schedule',
    outcome: 'done',
    workItemId: 'card-7',
    reason: null,
    triggeredBy: 'admin',
    ...overrides,
  });
  /** The fire endpoint; returns the route ids it was asked to fire, in order. */
  const useFireHandler = (respond: () => Response) => {
    const fired: string[] = [];
    server.use(
      http.post(`${ROUTES_URL}/:routeId/fire`, ({ params }) => {
        fired.push(String(params.routeId));
        return respond();
      }),
    );
    return fired;
  };
  const kindsHandlers = () =>
    server.use(
      http.get(`${ROUTES_URL}/kinds`, () =>
        HttpResponse.json({
          triggers: [{ kind: 'schedule', label: 'On a schedule (repeats)' }],
          actions: [{ kind: 'create-card', label: 'Create a card' }],
          policies: [{ kind: 'skip-if-open', label: 'Skip while the last card is open' }],
          placeholders: ['{date}', '{time}', '{route}'],
        }),
      ),
      http.post(`${ROUTES_URL}/preview`, () => HttpResponse.json({ summary: 'Daily at 09:00 (UTC)', nextFires: [], problems: [] })),
    );


  it('runs a scheduled route from its menu and opens the card it filed from the toast', async () => {
    const user = userEvent.setup();
    useRouteHandlers([scheduleRoute()]);
    kindsHandlers();
    const fired = useFireHandler(() => HttpResponse.json({ fire: fireOf({}) }));
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Security audit actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Run now' }));
    expect(await screen.findByText('“Security audit”: card created')).toBeTruthy();
    expect(fired).toEqual([ROUTE_ID]);
    await user.click(screen.getByRole('button', { name: 'Open card' }));
    expect(screen.getByRole('status', { name: 'location' }).textContent).toBe(`/factories/${PROJECT}/work?item=card-7`);
  });

  it('shows why a run was refused', async () => {
    const user = userEvent.setup();
    useRouteHandlers([scheduleRoute()]);
    kindsHandlers();
    useFireHandler(() =>
      HttpResponse.json({ error: 'intake_route_disabled', message: 'disabled' }, { status: 409 }),
    );
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Security audit actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Run now' }));
    expect(await screen.findByText('The route is switched off — switch it on to run it.')).toBeTruthy();
  });

  it('keeps a schedule out of the order arriving cards are tried in, with its next fire under it', async () => {
    useRouteHandlers([scheduleRoute(), catchAll]);
    kindsHandlers();
    renderSection();

    const schedules = await screen.findByRole('list', { name: 'Routes on a schedule' });
    expect(within(schedules).getByDisplayValue('Security audit')).toBeInTheDocument();
    expect(within(schedules).getByText('Daily at 09:00 (UTC)')).toBeInTheDocument();
    expect(within(routeList()).queryByDisplayValue('Security audit')).not.toBeInTheDocument();
  });

  it('«Save and run» saves a new schedule, then runs it once', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([catchAll]);
    kindsHandlers();
    const fired = useFireHandler(() => HttpResponse.json({ fire: fireOf({ workItemId: 'card-9' }) }));
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add schedule' }));
    const form = screen.getByRole('form', { name: 'New schedule' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Nightly audit');
    await user.type(within(form).getByRole('textbox', { name: 'Card title' }), 'Audit {{date}');
    await user.click(within(form).getByRole('combobox', { name: 'Route board' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await user.click(within(form).getByRole('button', { name: 'Save and run' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({ name: 'Nightly audit', when: null, triggered: { trigger: { kind: 'schedule' } } });
    await waitFor(() => expect(fired).toEqual(['00000000-0000-4000-8000-000000000009']));
  });
});
