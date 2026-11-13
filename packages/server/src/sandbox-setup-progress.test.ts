import { afterEach, describe, expect, it } from 'vitest';

import { createSandboxSetupReporter } from '@factory/sandbox';

import { forwardSandboxSetupProgress } from './sandbox-setup-progress.ts';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function stream() {
  const events: Array<{ type: string; status?: unknown; phase?: unknown }> = [];
  return { events, emit: (event: unknown) => events.push(event as (typeof events)[number]) };
}

describe('forwardSandboxSetupProgress', () => {
  it("puts a turn harness session's setup on its chat channel", async () => {
    const channel = stream();
    offs.push(
      forwardSandboxSetupProgress({
        turnChannel: id => (id === 'claude-1' ? channel : undefined),
        mastraSession: async () => undefined,
      }),
    );
    const reporter = createSandboxSetupReporter('claude-1', ['acme/api']);
    reporter.step('clone', 'acme/api');
    reporter.finish();

    expect(channel.events.map(event => [event.type, event.status, event.phase])).toEqual([
      ['factory_sandbox_setup', 'running', undefined],
      ['factory_sandbox_setup', 'running', 'clone'],
      ['factory_sandbox_setup', 'done', 'clone'],
    ]);
  });

  it("puts a Mastra session's setup on its live session, in order", async () => {
    const session = stream();
    let lookups = 0;
    offs.push(
      forwardSandboxSetupProgress({
        turnChannel: () => undefined,
        mastraSession: async id => {
          lookups += 1;
          // A slow first lookup must not let later events overtake it.
          await new Promise(resolve => setTimeout(resolve, lookups === 1 ? 20 : 0));
          return id === 'mastra-1' ? session : undefined;
        },
      }),
    );
    const reporter = createSandboxSetupReporter('mastra-1', ['acme/api']);
    reporter.step('checkout', 'acme/api');
    reporter.finish();
    createSandboxSetupReporter('nobody', ['acme/api']).finish();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(session.events.map(event => event.status)).toEqual(['running', 'running', 'done']);
  });
});
