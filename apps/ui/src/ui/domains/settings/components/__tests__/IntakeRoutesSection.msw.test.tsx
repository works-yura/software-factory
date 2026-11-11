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
    allowWorkingPhase: false,
    revision: 1,
    createdBy: 'admin',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-11-04T00:00:00.000Z',
    problems: [],
    ...overrides,
  };
}

const outsideAuthors = route({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Outside authors wait in Intake',
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'in', value: ['github', 'gitlab'] },
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

/** A project's routes behind the real API paths; returns what the UI wrote. */
function useRouteHandlers(initial: IntakeRouteInfo[]) {
  let routes = [...initial];
  const written = { created: [] as unknown[], patched: [] as unknown[], deleted: [] as string[], reordered: [] as string[][] };
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [workBoard] })),
    http.get(ROUTES_URL, () => HttpResponse.json({ intakeRoutes: routes })),
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
      return HttpResponse.json({ intakeRoutes: routes });
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
    expect(within(first!).getByText('When: GitHub or GitLab · outside author → Development › Intake')).toBeTruthy();
    expect(within(second!).getByText('When: ClickUp → Development › Triage')).toBeTruthy();
  });

  it('adds a route for ClickUp tasks with a tag, landing in a chosen phase', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Docs tasks to Triage');
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    await user.click(await screen.findByRole('option', { name: 'Tag' }));
    await user.type(within(form).getByRole('textbox', { name: 'Tag' }), 'docs');
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    await user.click(await screen.findByRole('option', { name: 'Source' }));
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
      when: {
        operator: 'AND',
        conditions: [
          { field: 'item.labels', operator: 'contains', value: 'docs' },
          { field: 'source.integration', operator: 'equals', value: 'clickup' },
        ],
      },
      target: { boardKey: 'work', phaseKey: 'triage', joinClosedIssue: false },
    });
    await waitFor(() => expect(routeRows()).toHaveLength(1));
  });

  it('adds a route that takes the cards of one intake rule, naming the rule in the list', async () => {
    const user = userEvent.setup();
    const written = useRouteHandlers([]);
    const RULE_ID = '00000000-0000-4000-8000-0000000000aa';
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/:id/intake-rules`, () =>
        HttpResponse.json({ intakeRules: [{ id: RULE_ID, name: 'Weekly security audit' }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/:id/intake-rules/kinds`, () =>
        HttpResponse.json({ triggers: [{ kind: 'schedule', label: 'On a schedule' }], actions: [], policies: [], placeholders: [] }),
      ),
    );
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add route' }));
    const form = screen.getByRole('form', { name: 'New route' });
    await user.type(within(form).getByRole('textbox', { name: 'Route name' }), 'Audits to Development');
    await user.click(within(form).getByRole('combobox', { name: 'Add condition' }));
    await user.click(await screen.findByRole('option', { name: 'Rule' }));
    await user.click(within(form).getByRole('combobox', { name: 'Rule' }));
    await user.click(await screen.findByRole('option', { name: 'Weekly security audit' }));
    await user.click(within(form).getByRole('combobox', { name: 'Route board' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(written.created).toHaveLength(1));
    expect(written.created[0]).toMatchObject({
      when: { operator: 'AND', conditions: [{ field: 'intake.rule', operator: 'equals', value: RULE_ID }] },
      target: { boardKey: 'work' },
    });
    await waitFor(() => expect(routeRows()).toHaveLength(1));
    expect(within(routeRows()[0]!).getByText(/from rule "Weekly security audit"/)).toBeTruthy();
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

  it('shows why a route is skipped', async () => {
    useRouteHandlers([route({ id: '00000000-0000-4000-8000-000000000004', name: 'To Docs', problems: ['Board "docs" is not installed in this project.'] })]);
    renderSection();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Route skipped: Board "docs" is not installed in this project.',
    );
  });
});
