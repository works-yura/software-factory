import type { ModelCatalogEntry } from '@factory/api/config';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../../e2e/ui/render';
import { ChatSessionContext } from '../../../context/ChatSessionContext';
import type { ChatSessionContextApi } from '../../../context/ChatSessionContext';
import { ModelSwitchRow } from '../ModelSwitchRow';
import type { ModelSwitch } from '../ModelSwitchRow';
import { claudeCodeTestInstance, mastraTestInstance } from './catalogInstances';

const MASTRA_MODELS: ModelCatalogEntry[] = [
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    modelName: 'gpt-5',
    hasApiKey: true,
    reasoningOptions: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }] as never,
  },
];

const session: ChatSessionContextApi = {
  sessionId: 'session-1',
  resourceId: 'user-1',
  sessionEnabled: true,
  resourceReady: true,
  sandboxReady: true,
  sandboxPreparing: false,
  resourceEnabled: true,
  baseUrl: TEST_BASE_URL,
  kind: 'user',
  // A draft reads the Factory-less catalog, which is all this divider needs.
  draftSessionId: 'draft-1',
};

function renderRow(modelSwitch: ModelSwitch) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/config/models`, () =>
      HttpResponse.json({ models: MASTRA_MODELS, instances: [mastraTestInstance(MASTRA_MODELS), claudeCodeTestInstance()] }),
    ),
  );
  return renderWithProviders(
    <MemoryRouter>
      <ChatSessionContext.Provider value={session}>
        <ModelSwitchRow modelSwitch={modelSwitch} />
      </ChatSessionContext.Provider>
    </MemoryRouter>,
  );
}

describe('ModelSwitchRow', () => {
  it('names the Claude Code models and efforts a turn switched between', async () => {
    renderRow({
      from: { instanceId: 'claude-code', model: 'opus', options: [{ id: 'effort', value: 'high' }] },
      to: { instanceId: 'claude-code', model: 'claude-sonnet-5-5', options: [{ id: 'effort', value: 'medium' }] },
    });

    expect(await screen.findByRole('separator', { name: 'Opus 5.5 High → Sonnet 5.5 Medium' })).toBeInTheDocument();
  });

  it("shows only the effort when a Mastra session kept its model", async () => {
    renderRow({
      from: { instanceId: 'mastra', model: 'openai/gpt-5', options: [{ id: 'effort', value: 'low' }] },
      to: { instanceId: 'mastra', model: 'openai/gpt-5', options: [{ id: 'effort', value: 'high' }] },
    });

    expect(await screen.findByRole('separator', { name: 'Low → High' })).toBeInTheDocument();
  });
});
