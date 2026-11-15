import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { builtinBoardCatalog } from './board-catalog';
import { boardReadHandlers } from './board-reads';

/**
 * Shared MSW server for the jsdom web-ui test suite. The global setup
 * (`vitest.setup.ts`) starts it with `onUnhandledRequest: 'error'` so any
 * request that isn't explicitly stubbed fails the test loudly. Register
 * per-test handlers with `server.use(...)`.
 *
 * `/auth/me` has a default handler because the auth state is ambient (read by
 * the user-sessions plumbing wherever the provider stack renders). Auth is
 * reported disabled by default; tests that exercise authenticated flows
 * override it with `server.use(...)`.
 */
export const server = setupServer(
  http.get('*/auth/me', () => HttpResponse.json(null, { status: 404 })),
  // Ambient model catalog for settings pickers; tests with model-specific
  // assertions override it with `server.use(...)`.
  http.get('*/web/config/models', () => HttpResponse.json({ models: [] })),
  // Ambient provider catalog (read by the NewPage credential guard wherever
  // it renders); credential-specific tests override it with `server.use(...)`.
  http.get('*/web/config/providers', () => HttpResponse.json({ providers: [] })),
  // Ambient usage: no allowance read yet, no turns recorded; usage tests override these with `server.use(...)`.
  http.get('*/web/usage/limits', () => HttpResponse.json({ accounts: [] })),
  http.get('*/web/usage/sessions/:sessionId', ({ params }) =>
    HttpResponse.json({
      usage: {
        sessionId: params.sessionId,
        turns: [],
        total: {
          turns: 0,
          totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          totalTokens: 0,
          costUsd: 0,
          reportedCostUsd: 0,
          unpricedTurns: 0,
        },
        context: null,
      },
    }),
  ),
  http.get('*/web/usage/work-items', () => HttpResponse.json({ workItems: {} })),
  // Experimental surfaces stay hidden unless a test explicitly enables them.
  http.get('*/web/config/features', () => HttpResponse.json({ knowledge: false })),
  http.get('*/web/status', () => HttpResponse.json({ problems: [] })),
  // Ambient assistant (ADR-0051): an empty desk, nothing allowed yet. Assistant tests override these.
  http.get('*/web/assistant/requests', () => HttpResponse.json({ requests: [] })),
  http.get('*/web/assistant/notes', () => HttpResponse.json({ notes: [] })),
  http.get('*/web/assistant/settings', () => HttpResponse.json({ settings: { modelId: null, retentionDays: 30 } })),
  http.get('*/web/assistant/models', () => HttpResponse.json({ models: [] })),
  http.get('*/web/assistant/factories', () => HttpResponse.json({ connected: false, pending: false, factories: [] })),
  http.get('*/web/assistant/model-status', () => HttpResponse.json({ providers: [] })),
  http.get('*/web/assistant/skills', () => HttpResponse.json({ skills: [] })),
  // Ambient activity poll (sidebar running dots); activity tests override it with `server.use(...)`.
  http.get('*/api/agent-controller/:controllerId/active-runs', () => HttpResponse.json({ runs: [] })),
  http.get('*/web/factory/projects/:id/boards', () => HttpResponse.json(builtinBoardCatalog)),
  // Ambient env files (an open repository card in Environment settings); env file tests override it.
  http.get('*/web/factory/projects/:id/sandbox-env-files', () =>
    HttpResponse.json({ files: [], writable: true, canManage: true }),
  ),
  // Ambient run queue: no automated run waits for a slot. Run-queue tests override it with `server.use(...)`.
  http.get('*/web/factory/projects/:id/run-queue', () =>
    HttpResponse.json({ slots: null, running: 0, claimed: [], queuedCount: 0, queued: [] }),
  ),
  // The sidebar and the board page read the intake routes to learn whether the caller may change
  // boards. The ambient caller is a member who may not; board tests override it with `server.use(...)`.
  // Routes are what a project reads (ADR-0022): the board suites' project reads its linked
  // `acme/app` through one GitHub repository route. Tests about routes override this.
  http.get('*/web/factory/projects/:id/intake-routes', () =>
    HttpResponse.json({
      intakeRoutes: [
        {
          id: 'route-acme-app',
          name: 'GitHub: acme/app',
          enabled: true,
          on: ['work_item.created'],
          when: {
            operator: 'AND',
            conditions: [
              { field: 'source.integration', operator: 'equals', value: 'github' },
              { field: 'source.repository', operator: 'equals', value: 'acme/app' },
            ],
          },
          target: { boardKey: 'work', phaseKey: 'intake' },
          position: 0,
          revision: 1,
          triggered: null,
          origin: { kind: 'repository', integrationId: 'github', repository: 'acme/app', generatedName: 'GitHub: acme/app' },
        },
      ],
      canEdit: false,
    }),
  ),
  http.get('*/web/factory/projects', () => HttpResponse.json({ projects: [] })),
  // A server without Platform machine credentials mounts no platform connect
  // routes; the ambient 404 hides the provider sections. Provider connection
  // tests override these with `server.use(...)`.
  http.get('*/web/integrations/platform/:provider/connections', () =>
    HttpResponse.json({ error: 'not_found' }, { status: 404 }),
  ),
  // Board filters read connection status even when no provider is configured.
  http.get('*/web/github/status', () => HttpResponse.json({ enabled: false, connected: false, installations: [] })),
  // Ambient pull requests: Work and Review both list their linked repositories'
  // open pull requests. Pull-request tests override these with `server.use(...)`.
  http.get('*/web/github/projects/:id/prs', () => HttpResponse.json({ pullRequests: [], nextPage: null })),
  http.get('*/web/gitlab/projects/:id/prs', () => HttpResponse.json({ pullRequests: [], nextPage: null })),
  // GitLab intake is optional; feature tests override these ambient 404s.
  http.get('*/web/gitlab/status', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
  http.get('*/web/gitlab/projects', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
  http.get('*/web/factory/projects/:id/source-control-connections', () => HttpResponse.json({ connections: [] })),
  // Ambient sandbox environment variables (Manage Factory); variable tests override it with `server.use(...)`.
  http.get('*/web/factory/projects/:id/sandbox-envs', () =>
    HttpResponse.json({ envs: [], writable: true, stages: ['development'], canManage: true }),
  ),
  http.get('*/web/factory/projects/:id/audit', () => HttpResponse.json({ events: [], actors: {} })),
  http.get('*/web/factory/projects/:id/decisions', () => HttpResponse.json({ decisions: [] })),
  // What a test stubs here is the project's cards: the board's paged reads are answered from it.
  http.get('*/web/factory/projects/:id/work-items', () => HttpResponse.json({ workItems: [] })),
  http.get('*/web/factory/projects/:id/mention-roster', () => HttpResponse.json({ members: [] })),
  // Ambient feed stream: `FactoryLayout` mounts it on every routed surface. It
  // must never close — a closing stream puts every test into the retry loop.
  http.get(
    '*/web/factory/projects/:id/feed-events',
    () =>
      new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  ),
  http.get('*/web/factory/work-items/:workItemId/comments', () => HttpResponse.json({ comments: [] })),
  ...boardReadHandlers,
  // Ambient empty board for the draft page's starters and activity; their tests override these with `server.use(...)`.
  http.get('*/web/factory/projects/:id/work-items/starters', () =>
    HttpResponse.json({
      failed: 0,
      changesRequested: 0,
      review: { count: 0 },
      undecided: 0,
      untriaged: 0,
      unplannedBugs: 0,
      stale: 0,
    }),
  ),
  http.get('*/web/factory/projects/:id/work-items/activity', () =>
    HttpResponse.json({ total: 0, createdAt: [], doneAt: [] }),
  ),
  http.get('*/web/github/projects/:projectRepositoryId/worktrees', () => HttpResponse.json({ worktrees: [] })),
);
