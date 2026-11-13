import type { AgentControllerEvent } from '@mastra/client-js';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { waitForMutationsIdle } from '../../../../../../e2e/ui/render';
import { renderThread, stubPreparingSession } from './composer-session-test-fixture';

type User = ReturnType<typeof userEvent.setup>;

async function send(user: User) {
  const message = () => screen.getByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(message()).toBeEnabled());
  await user.type(message(), 'fix the login page');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByText('fix the login page')).toBeInTheDocument());
}

function setupEvent(event: Record<string, unknown>): AgentControllerEvent {
  return { type: 'factory_sandbox_setup', total: 5, ...event } as AgentControllerEvent;
}

function line() {
  return screen.getByTestId('sandbox-setup-line');
}

describe('SandboxSetupLine', () => {
  it('says what the sandbox setup is doing in place of Thinking, then the time it took', async () => {
    const session = stubPreparingSession({ autoAgentEnd: false });
    const user = userEvent.setup();
    const { client } = renderThread();
    session.finishWorkspace();
    await waitForMutationsIdle(client);
    await send(user);
    await session.emit({ type: 'agent_start' });

    await session.emit(setupEvent({ status: 'running', elapsedMs: 0 }));
    await session.emit(
      setupEvent({
        status: 'running',
        phase: 'clone',
        repo: 'acme/book_fate',
        index: 2,
        elapsedMs: 12_000,
        receivedBytes: 3 * 1024 ** 2,
        percent: 40,
      }),
    );

    await waitFor(() => expect(line()).toHaveTextContent(/Setting up the sandbox.*cloning book_fate \(2 of 5\) · 3\.0 MB · 40% · 1\d s/));
    expect(line()).toHaveAttribute('data-status', 'running');
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();

    await session.emit(setupEvent({ status: 'running', phase: 'setup', repo: 'acme/api', index: 1, elapsedMs: 30_000 }));
    await waitFor(() => expect(line()).toHaveTextContent('installing dependencies of api (1 of 5)'));

    await session.emit(setupEvent({ status: 'done', phase: 'setup', elapsedMs: 42_000 }));
    await waitFor(() => expect(line()).toHaveTextContent('Sandbox ready in 42 s'));
    expect(line()).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('leaves no summary behind a setup that took no time', async () => {
    const session = stubPreparingSession({ autoAgentEnd: false });
    const user = userEvent.setup();
    const { client } = renderThread();
    session.finishWorkspace();
    await waitForMutationsIdle(client);
    await send(user);
    await session.emit({ type: 'agent_start' });

    await session.emit(setupEvent({ status: 'running', phase: 'checkout', repo: 'acme/api', index: 1, elapsedMs: 300 }));
    await waitFor(() => expect(line()).toHaveTextContent('checking out the session branch of api'));
    await session.emit(setupEvent({ status: 'done', phase: 'checkout', elapsedMs: 900 }));

    await waitFor(() => expect(screen.queryByTestId('sandbox-setup-line')).not.toBeInTheDocument());
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('names the repository and step that failed and why, with the server message at hand', async () => {
    const session = stubPreparingSession({ autoAgentEnd: false });
    const user = userEvent.setup();
    const { client } = renderThread();
    session.finishWorkspace();
    await waitForMutationsIdle(client);
    await send(user);
    await session.emit({ type: 'agent_start' });

    await session.emit(
      setupEvent({
        status: 'failed',
        phase: 'clone',
        repo: 'acme/book_fate',
        index: 2,
        elapsedMs: 250_000,
        failures: [
          {
            code: 'timeout',
            message: 'Sandbox command timed out after 900s during repository clone.',
            phase: 'clone',
            repo: 'acme/book_fate',
          },
        ],
      }),
    );

    await waitFor(() => expect(line()).toHaveAttribute('data-status', 'failed'));
    expect(line()).toHaveTextContent('Sandbox setup failed');
    expect(line()).toHaveTextContent('book_fate · clone: timed out: the git host answered too slowly');
    expect(line()).toHaveAttribute('title', 'Sandbox command timed out after 900s during repository clone.');
    expect(line().querySelector('[data-status="error"]')).not.toBeNull();
  });
});

