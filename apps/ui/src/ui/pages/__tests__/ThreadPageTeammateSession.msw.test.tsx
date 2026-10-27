import type { ModelCatalogEntry } from '@factory/api/config';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../../e2e/ui/render';
import { createAppRoutes } from '../../router';

if (typeof globalThis.Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const FACTORY_ID = 'fp-1';
const REPO_ID = 'ghp-1';
const SESSION_ID = 'sess-ward';
const AC = `${TEST_BASE_URL}/api/agent-controller/code`;

const wardSession = {
  id: 'row-1',
  sessionId: SESSION_ID,
  projectRepositoryId: REPO_ID,
  orgId: 'org-1',
  userId: 'user-ward',
  owner: { id: 'user-ward', name: 'Ward Peeters' },
  visibility: 'org',
  title: 'Checkout e2e test flakes on CI',
  branch: `user/session-${SESSION_ID}`,
  baseBranch: 'main',
  sandboxId: 'sb-1',
  sandboxWorkdir: '/local/acme/app',
  materializedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  capabilities: { recreateSandbox: false, switchModel: false },
};

const wardSessionWithoutProfile = { ...wardSession, owner: undefined };
const USER_THREAD_PATH = `/factories/${FACTORY_ID}/user/threads/${SESSION_ID}`;
const BOARD_THREAD_PATH = `/factories/${FACTORY_ID}/workspaces/${SESSION_ID}/threads/thread-review-1`;

const openAIKeyModel: ModelCatalogEntry = {
  id: 'openai/gpt-4o-mini',
  provider: 'openai',
  modelName: 'gpt-4o-mini',
  hasApiKey: true,
  credentialLabel: 'OpenAI API key',
  credentialHolder: 'organization',
};

/** The Factory's model catalog: v4 has no personal scope, so every session reads the Factory's. */
function serveModelCatalog() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}`, () =>
      HttpResponse.json({ project: { id: FACTORY_ID, name: 'Acme Factory', defaultModelId: 'openai/gpt-4o-mini' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({ defaultModelId: null, models: [openAIKeyModel] }),
    ),
  );
}

function openWardSessionAs(
  viewerUserId: string,
  {
    session = wardSession,
    path = USER_THREAD_PATH,
  }: { session?: typeof wardSession | typeof wardSessionWithoutProfile; path?: string } = {},
) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: viewerUserId } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme Factory' }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/source-control-connections`, () =>
      HttpResponse.json({
        connections: [
          {
            id: 'conn-1',
            installationId: 'inst-1',
            repositories: [
              {
                id: REPO_ID,
                branch: 'main',
                sandboxWorkdir: '/local/acme/app',
                repository: { slug: 'acme/app', defaultBranch: 'main' },
              },
            ],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () =>
      HttpResponse.json({ workItems: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sessions`, () =>
      HttpResponse.json({ sessions: [session] }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/subscriptions`, () => HttpResponse.json({ subscriptions: [] })),
    http.get(`${TEST_BASE_URL}/web/user-sessions/${SESSION_ID}`, () => HttpResponse.json({ session })),
    http.post(`${AC}/sessions`, () =>
      HttpResponse.json({ controllerId: 'code', resourceId: SESSION_ID, threadId: SESSION_ID }),
    ),
    http.get(`${AC}/sessions/:resourceId`, () =>
      HttpResponse.json({
        controllerId: 'code',
        resourceId: SESSION_ID,
        modeId: 'build',
        modelId: 'openai/gpt-4o-mini',
        threadId: SESSION_ID,
        settings: { yolo: false, thinkingLevel: 'medium', notifications: 'bell', smartEditing: true },
      }),
    ),
    http.put(`${AC}/sessions/:resourceId/state`, () => HttpResponse.json({ ok: true })),
    http.get(
      `${AC}/sessions/:resourceId/stream`,
      () =>
        new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(`${AC}/sessions/:resourceId/permissions`, () => HttpResponse.json({})),
    http.get(`${AC}/sessions/:resourceId/threads`, () => HttpResponse.json({ threads: [] })),
    http.get(`${AC}/sessions/:resourceId/threads/:threadId/messages`, () => HttpResponse.json({ messages: [] })),
  );
  const router = createMemoryRouter(createAppRoutes(), {
    initialEntries: [path],
  });
  return renderWithProviders(<RouterProvider router={router} />).client;
}

describe("a teammate's Factory session", () => {
  describe('when a teammate opens it', () => {
    it('names the owner inside the composer region', async () => {
      openWardSessionAs('user-damien');

      const composer = await screen.findByRole('region', { name: 'Thread composer' });
      expect(await within(composer).findByText('You’re steering Ward Peeters’s session')).toBeInTheDocument();
    });

    it('names the owner on a Work or Review board thread too', async () => {
      openWardSessionAs('user-damien', { path: BOARD_THREAD_PATH });

      expect(await screen.findByText('You’re steering Ward Peeters’s session')).toBeInTheDocument();
    });

    it('says "a teammate" when the owner has no profile, never the raw user id', async () => {
      openWardSessionAs('user-damien', { session: wardSessionWithoutProfile });

      expect(await screen.findByText('You’re steering a teammate’s session')).toBeInTheDocument();
      expect(screen.queryByText(/user-ward/)).not.toBeInTheDocument();
    });
  });

  describe('when a teammate tries to change its model', () => {
    const lockedReason = 'Only Ward Peeters can change this session’s model or thinking level.';

    it('shows the model and thinking level disabled, with who can change them', async () => {
      serveModelCatalog();
      openWardSessionAs('user-damien');
      const user = userEvent.setup();

      const model = await screen.findByRole('button', { name: `Session model: GPT-4o Mini. ${lockedReason}` });
      expect(model).toHaveAttribute('aria-disabled', 'true');
      const thinking = await screen.findByRole('button', { name: `Thinking: Medium. ${lockedReason}` });
      expect(thinking).toHaveAttribute('aria-disabled', 'true');

      await user.hover(model);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(lockedReason);
    });

    it('refuses /model and /think without changing the session', async () => {
      const modelSwitches: unknown[] = [];
      const stateWrites: unknown[] = [];
      serveModelCatalog();
      openWardSessionAs('user-damien');
      server.use(
        http.post(`${AC}/sessions/:resourceId/model`, async ({ request }) => {
          modelSwitches.push(await request.json());
          return HttpResponse.json({ ok: true });
        }),
        http.put(`${AC}/sessions/:resourceId/state`, async ({ request }) => {
          stateWrites.push(await request.json());
          return HttpResponse.json({ ok: true });
        }),
      );
      const user = userEvent.setup();

      const input = await screen.findByRole('textbox', { name: 'Message' });
      await waitFor(() => expect(input).toBeEnabled());
      await user.type(input, '/model openai/gpt-5-mini');
      await user.keyboard('{Enter}');
      await user.type(input, '/think high');
      await user.keyboard('{Enter}');

      await waitFor(() => expect(screen.getAllByText(lockedReason)).toHaveLength(2));
      expect(modelSwitches).toEqual([]);
      expect(stateWrites).not.toContainEqual({ state: { thinkingLevel: 'high' } });
    });

    it('keeps the picker for the owner', async () => {
      serveModelCatalog();
      openWardSessionAs('user-ward', {
        session: { ...wardSession, capabilities: { recreateSandbox: false, switchModel: true } },
      });

      expect(await screen.findByRole('button', { name: 'Session model' })).toBeInTheDocument();
    });
  });

  describe('when the owner opens it', () => {
    it('shows no steering line', async () => {
      const client = openWardSessionAs('user-ward');

      await screen.findByRole('region', { name: 'Thread composer' });
      await waitForMutationsIdle(client);
      expect(screen.queryByText(/You’re steering/)).not.toBeInTheDocument();
    });
  });
});
