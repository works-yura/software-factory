import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { Toaster } from '@mastra/playground-ui/components/Toaster';

import { listedRepository } from '../../../../../../e2e/ui/factory-projects';
import { server } from '../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../e2e/ui/render';
import type { FactoryUserSession } from '../../services/user-sessions';
import { ChatSessionContext } from '../../../chat/context/ChatSessionContext';
import { FACTORY_REF_EVENT, FACTORY_REF_MIME } from '../../../chat/services/factoryRefs';
import type { FactoryRef } from '../../../chat/services/factoryRefs';
import { SessionsSection } from '../SessionsSection';
import { testChatSession } from './fixtures/sessionsSection';

const projectRepositoryId = 'ghp-1';
const TITLE = 'Inbox sorting';

const session: FactoryUserSession = {
  id: 'row-1',
  sessionId: 'sess-1',
  projectRepositoryId,
  orgId: 'org-1',
  userId: 'user-1',
  visibility: 'org' as const,
  branch: 'user/inbox',
  baseBranch: 'main',
  title: TITLE,
  sandboxId: null,
  sandboxWorkdir: null,
  materializedAt: null,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};

function renderSection() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: 'fp-1',
            name: 'Mastra',
            repositories: [
              listedRepository(projectRepositoryId, 'octo/hello', { branch: 'main', sandboxWorkdir: '/workspace/hello' }),
            ],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:factoryId/sessions`, () => HttpResponse.json({ sessions: [session] })),
    http.get(`${TEST_BASE_URL}/api/agent-controller/:agentControllerId/sessions/:resourceId/threads`, () =>
      HttpResponse.json({ threads: [] }),
    ),
  );
  return renderWithProviders(
    <MemoryRouter initialEntries={['/factories/fp-1']}>
      <ChatSessionContext.Provider value={testChatSession('fp-1', projectRepositoryId)}>
        <Routes>
          <Route path="/factories/:factoryId" element={<SessionsSection />} />
        </Routes>
      </ChatSessionContext.Provider>
      <Toaster position="bottom-right" />
    </MemoryRouter>,
  );
}

let listener: ((event: Event) => void) | undefined;
afterEach(() => {
  if (listener) window.removeEventListener(FACTORY_REF_EVENT, listener);
  listener = undefined;
});

describe('A session row as a chat reference', () => {
  it('carries the session as a typed payload when dragged', async () => {
    renderSection();
    const row = await screen.findByRole('button', { name: TITLE });
    expect(row).toHaveAttribute('draggable', 'true');
    const data = new Map<string, string>();
    fireEvent.dragStart(row, {
      dataTransfer: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: 'all' },
    });
    expect(JSON.parse(data.get(FACTORY_REF_MIME)!)).toEqual({ kind: 'session', sessionId: 'sess-1', title: TITLE });
    expect(data.get('text/plain')).toBe(TITLE);
  });

  it('is added to the open composer from its actions menu', async () => {
    const added: FactoryRef[] = [];
    listener = event => {
      event.preventDefault();
      added.push((event as CustomEvent<FactoryRef>).detail);
    };
    window.addEventListener(FACTORY_REF_EVENT, listener);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: `Session actions for ${TITLE}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add to chat' }));
    expect(added).toEqual([{ kind: 'session', title: TITLE, fields: { sessionId: 'sess-1' } }]);
  });

  it('says so when no chat is open to take it', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: `Session actions for ${TITLE}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add to chat' }));
    expect(await screen.findByText(`Open a chat to add ${TITLE} to it`)).toBeInTheDocument();
  });
});
