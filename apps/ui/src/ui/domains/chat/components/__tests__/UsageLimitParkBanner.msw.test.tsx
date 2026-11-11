import { CLAUDE_CODE_HARNESS, MASTRA_HARNESS } from '@factory/contracts/harnesses';
import type { HarnessDescriptor } from '@factory/contracts/harnesses';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { ChatConnectionContext } from '../../context/ChatConnectionContext';
import { ChatSessionContext } from '../../context/ChatSessionContext';
import { AGENT_CONTROLLER_ID } from '../../services/constants';
import { UsageLimitParkBanner } from '../UsageLimitParkBanner';

const SESSION = `${TEST_BASE_URL}/api/agent-controller/${AGENT_CONTROLLER_ID}/sessions/session-1`;

function usageLimit(until: Date, attempts = 1) {
  return {
    reason: 'usage_limit',
    parkedUntil: until.toISOString(),
    resetKnown: true,
    since: new Date().toISOString(),
    attempts,
    message: 'Every Claude account this run may use is out of usage.',
  };
}

function ParkedChat({ harness = CLAUDE_CODE_HARNESS }: { harness?: HarnessDescriptor }) {
  return (
    <ChatSessionContext.Provider
      value={{
        sessionId: 'session-1',
        resourceId: 'resource-1',
        sessionThreadId: 'session-1',
        sessionEnabled: true,
        resourceReady: true,
        sandboxReady: true,
        sandboxPreparing: false,
        resourceEnabled: true,
        baseUrl: TEST_BASE_URL,
        kind: 'user',
        harness,
      }}
    >
      <ChatConnectionContext.Provider value={{ status: 'ready', state: { running: false } as never }}>
        <UsageLimitParkBanner />
      </ChatConnectionContext.Provider>
    </ChatSessionContext.Provider>
  );
}

const clock = (date: Date) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(date);

describe('UsageLimitParkBanner', () => {
  it('says when a parked session resumes, with a countdown, and "Resume now" shows the new time while still limited', async () => {
    const until = new Date(Date.now() + 90 * 60_000);
    until.setSeconds(0, 0);
    const later = new Date(until.getTime() + 60 * 60_000);
    let resumes = 0;
    server.use(
      http.get(SESSION, () => HttpResponse.json({ running: false, usageLimit: usageLimit(until) })),
      http.post(`${SESSION}/resume`, () => {
        resumes += 1;
        return HttpResponse.json({ ok: true, action: 'parked', usageLimit: usageLimit(later, 2) });
      }),
    );
    renderWithProviders(<ParkedChat />);

    // The day is named too when the reset is not today.
    expect(await screen.findAllByText(new RegExp(`Usage limit reached on every account · resumes at .*${clock(until)}$`))).not.toHaveLength(0);
    expect(screen.getByText(/resumes on its own in 1 h (29|30) min/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(resumes).toBe(1));
    expect(await screen.findAllByText(new RegExp(`resumes at .*${clock(later)}$`))).not.toHaveLength(0);
    expect(screen.getByText(/Every account is still out of usage\./)).toBeInTheDocument();
  });

  it('goes away once "Resume now" resumed the session', async () => {
    server.use(
      http.get(SESSION, () => HttpResponse.json({ running: false, usageLimit: usageLimit(new Date(Date.now() + 10 * 60_000)) })),
      http.post(`${SESSION}/resume`, () => HttpResponse.json({ ok: true, action: 'resumed', runId: 'run-1', usageLimit: null })),
    );
    renderWithProviders(<ParkedChat />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume now' })).not.toBeInTheDocument());
  });

  it('shows nothing for a session that is not parked, or a Mastra one', async () => {
    let reads = 0;
    server.use(
      http.get(SESSION, () => {
        reads += 1;
        return HttpResponse.json({ running: false, usageLimit: null });
      }),
    );
    renderWithProviders(<ParkedChat />);
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole('button', { name: 'Resume now' })).not.toBeInTheDocument();

    renderWithProviders(<ParkedChat harness={MASTRA_HARNESS} />);
    expect(reads).toBe(1);
  });
});
