import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '../../../../i18n';
import { initialChatRuntime, runtimeReducer } from '../runtime';
import type { ChatRuntimeState } from '../runtime';
import { readSandboxSetupEvent, sandboxSetupWords } from '../sandbox-setup';

const NOW = 1_000_000;

/** An event as the stream delivers it: a type and whatever else it carries. */
const wire = (event: Record<string, unknown>) => event as { type: string };

function setup(event: Record<string, unknown>) {
  const state = readSandboxSetupEvent(wire({ type: 'factory_sandbox_setup', total: 5, ...event }), NOW);
  if (!state) throw new Error('expected a setup');
  return state;
}

const cloning = { status: 'running', phase: 'clone', repo: 'acme/book_fate', index: 2, elapsedMs: 75_000 };
const failed = {
  status: 'failed',
  phase: 'clone',
  repo: 'acme/book_fate',
  index: 2,
  elapsedMs: 250_000,
  failures: [
    { code: 'timeout', message: 'git clone failed: fatal: early EOF', phase: 'clone', repo: 'acme/book_fate' },
    { code: 'setup_failed', message: 'Setup command failed', phase: 'setup' },
  ],
};

describe('sandbox setup words', () => {
  afterEach(() => i18n.changeLanguage('en'));

  it('names the step, the repository, its position and the transfer while the setup runs', () => {
    expect(sandboxSetupWords(setup({ ...cloning, receivedBytes: 12.5 * 1024 ** 2, percent: 45 }), NOW + 2_000)).toEqual({
      label: 'Setting up the sandbox',
      detail: 'cloning book_fate (2 of 5) · 12.5 MB · 45% · 1 min 17 s',
    });
    expect(sandboxSetupWords(setup({ status: 'running', phase: 'setup', elapsedMs: 3_000 }), NOW).detail).toBe(
      'running the workspace setup · 3 s',
    );
    expect(sandboxSetupWords(setup({ status: 'running', elapsedMs: 0, total: 1 }), NOW).detail).toBe('0 s');
    expect(
      sandboxSetupWords(setup({ status: 'running', phase: 'setup', repo: 'acme/api', index: 1, total: 1, elapsedMs: 0 }), NOW)
        .detail,
    ).toBe('installing dependencies of api · 0 s');
  });

  it('collapses to the time it took, and names what failed and why', () => {
    expect(sandboxSetupWords(setup({ status: 'done', elapsedMs: 42_000 }), NOW + 99_000)).toEqual({
      label: 'Sandbox ready in 42 s',
    });
    expect(sandboxSetupWords(setup(failed), NOW)).toEqual({
      label: 'Sandbox setup failed',
      detail: 'book_fate · clone: timed out: the git host answered too slowly · and 1 more',
      title: 'git clone failed: fatal: early EOF\n\nSetup command failed',
    });
  });

  it("speaks the viewer's language", async () => {
    await i18n.changeLanguage('uk');
    expect(sandboxSetupWords(setup({ ...cloning, receivedBytes: 12.5 * 1024 ** 2 }), NOW)).toEqual({
      label: 'Розгортаю пісочницю',
      detail: 'клоную book_fate (2 з 5) · 12,5 МБ · 1 хв 15 с',
    });
    expect(sandboxSetupWords(setup({ status: 'done', elapsedMs: 42_000 }), NOW).label).toBe('Пісочницю розгорнуто за 42 с');
    expect(sandboxSetupWords(setup(failed), NOW).detail).toBe(
      'book_fate · клонування: час вичерпано: git-хостинг відповідав надто повільно · і ще 1',
    );
  });

  it('reads only its own event, tolerating fields it does not know', () => {
    expect(readSandboxSetupEvent({ type: 'agent_start' })).toBeUndefined();
    expect(
      readSandboxSetupEvent(wire({ type: 'factory_sandbox_setup', status: 'weird', phase: 'teleport', failures: [{ code: 'x' }] }), NOW),
    ).toEqual({ status: 'running', startedAt: NOW, elapsedMs: 0, total: 1, failures: [{ code: 'unknown', message: '' }], notices: [] });
  });

  it('says whether a clone comes from the mirror or the network', async () => {
    expect(sandboxSetupWords(setup({ ...cloning, source: 'mirror' }), NOW).detail).toBe('cloning book_fate from the mirror (2 of 5) · 1 min 15 s');
    expect(sandboxSetupWords(setup({ ...cloning, source: 'network' }), NOW).detail).toBe('cloning book_fate from the network (2 of 5) · 1 min 15 s');
    await i18n.changeLanguage('uk');
    expect(sandboxSetupWords(setup({ ...cloning, source: 'mirror' }), NOW).detail).toBe('клоную book_fate з дзеркала (2 з 5) · 1 хв 15 с');
  });

  it('keeps what the person should know on the finished line: restored work, a diverged branch', async () => {
    const done = setup({
      status: 'done',
      elapsedMs: 2_000,
      notices: [
        { code: 'restored', repo: 'acme/book_fate' },
        { code: 'diverged', repo: 'acme/book_fate', message: 'Kept the saved commits (abc); the remote branch is at origin/x (def).' },
        { code: 'teleported' },
      ],
    });
    expect(done.notices).toHaveLength(2);
    expect(sandboxSetupWords(done, NOW)).toEqual({
      label: 'Sandbox ready in 2 s',
      detail:
        'book_fate: saved work restored · book_fate: the branch went apart from the remote — your saved commits are kept, the remote one is at origin',
      title: 'Kept the saved commits (abc); the remote branch is at origin/x (def).',
    });
    await i18n.changeLanguage('uk');
    expect(sandboxSetupWords(done, NOW).detail).toContain('гілка розійшлася з GitHub');
  });
});

describe('sandbox setup in the chat runtime', () => {
  const event = (value: Record<string, unknown>) => ({ type: 'event' as const, event: { type: 'factory_sandbox_setup', total: 5, ...value } });

  it('keeps a running setup across the run start and drops an ended one at the next run', () => {
    let state: ChatRuntimeState = runtimeReducer(initialChatRuntime, event(cloning));
    state = runtimeReducer(state, { type: 'event', event: { type: 'agent_start' } });
    expect(state.sandboxSetup).toMatchObject({ status: 'running', repo: 'acme/book_fate', index: 2 });

    state = runtimeReducer(state, event({ status: 'done', elapsedMs: 42_000 }));
    expect(state.sandboxSetup?.status).toBe('done');
    state = runtimeReducer(state, { type: 'event', event: { type: 'agent_start' } });
    expect(state.sandboxSetup).toBeUndefined();
  });
});
