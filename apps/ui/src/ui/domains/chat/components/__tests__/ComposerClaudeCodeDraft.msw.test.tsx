import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, waitForMutationsIdle } from '../../../../../../e2e/ui/render';
import {
  FACTORY_ID,
  PROJECT_REPOSITORY_ID,
  SESSION_ID,
  createdDraftSession,
  renderDraft,
  stubPreparingSession,
} from './composer-session-test-fixture';

const API = `${TEST_BASE_URL}/api/agent-controller/code`;

/** The fixture's Factory, switched to Claude Code, with no Mastra model or provider key anywhere. */
function serveClaudeCodeFactory() {
  const factory = {
    id: FACTORY_ID,
    name: 'Preparing',
    harness: 'claude-code',
    claudeCodeModel: 'opus',
    defaultModelId: null,
  };
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [factory] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}`, () => HttpResponse.json({ project: factory })),
    http.get(`${TEST_BASE_URL}/web/config/models`, () => HttpResponse.json({ models: [], fallbackModelId: null })),
    http.get(`${TEST_BASE_URL}/web/config/providers`, () => HttpResponse.json({ providers: [] })),
    http.get(`${API}/models`, () => HttpResponse.json({ models: [] })),
  );
}

describe('Composer on a draft in a Claude Code Factory', () => {
  it('starts the session without a Mastra model and shows the Factory’s Claude model', async () => {
    const preparation = stubPreparingSession({ createdSessionTitle: 'fix the login bug' });
    serveClaudeCodeFactory();
    const createBodies: unknown[] = [];
    server.use(
      http.post(
        `${TEST_BASE_URL}/web/source-control/projects/${PROJECT_REPOSITORY_ID}/sessions`,
        async ({ request }) => {
          createBodies.push(await request.json());
          return HttpResponse.json({
            session: {
              ...createdDraftSession('fix the login bug'),
              harness: 'claude-code',
              capabilities: { recreateSandbox: false, switchModel: false },
            },
          });
        },
      ),
    );
    const user = userEvent.setup();
    const { client } = renderDraft();

    expect(await screen.findByRole('link', { name: /Claude Code · Opus/ })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/models`,
    );
    const message = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(message).toBeEnabled());
    await user.type(message, 'fix the login bug');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(createBodies).toEqual([{ sessionId: SESSION_ID, title: 'fix the login bug', visibility: 'private' }]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent(`/factories/${FACTORY_ID}/user/threads/${SESSION_ID}`),
    );
    preparation.finishWorkspace();
    await waitForMutationsIdle(client);
    await waitFor(() => expect(preparation.delivered).toEqual(['fix the login bug']));
    // Nothing asks the session to switch to a Mastra model.
    expect(preparation.operations.filter(operation => operation.startsWith('model:'))).toEqual([]);
    expect(screen.queryByText(/configuration is not ready/i)).not.toBeInTheDocument();
  });

  it('says what the server answered when it cannot run a Claude Code chat', async () => {
    stubPreparingSession({ createdSessionTitle: 'fix it' });
    serveClaudeCodeFactory();
    server.use(
      http.post(`${TEST_BASE_URL}/web/source-control/projects/${PROJECT_REPOSITORY_ID}/sessions`, () =>
        HttpResponse.json(
          { error: 'claude_code_unavailable', message: 'Claude Code chats need a local sandbox.' },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDraft();

    const message = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(message).toBeEnabled());
    await user.type(message, 'fix it');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/Claude Code chats need a local sandbox\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('fix it'));
  });
});
