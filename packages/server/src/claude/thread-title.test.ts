import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';
import { observeClaudeThreadTitle, type ClaudeTitleChannel } from './thread-title.ts';

/** A Claude session's chat channel over one thread, with the session row the sidebar reads. */
function fakeChannel(options: { title?: string; startTitle?: string } = {}) {
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  const settings: Record<string, unknown> = {};
  if (options.startTitle) settings[CLAUDE_THREAD_SETTINGS.title] = options.startTitle;
  let title = options.title ?? '';
  const emitted: AgentControllerEvent[] = [];
  const emit = (event: AgentControllerEvent) => {
    emitted.push(event);
    for (const listener of [...listeners]) listener(event);
  };
  const channel: ClaudeTitleChannel = {
    session: { id: 'session-1', thread: { getSetting: async ({ key }) => settings[key] } },
    threadId: 'session-1',
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit,
    nameThread: async next => {
      if (next === title) return false;
      title = next;
      emit({ type: 'thread_title_updated', threadId: 'session-1', title: next });
      return true;
    },
    threadTitle: async () => title,
    getThread: async threadId =>
      threadId === 'session-1'
        ? { id: threadId, resourceId: 'factory-1', title, createdAt: new Date(0), updatedAt: new Date(0) }
        : null,
  };
  const row = { sessionId: 'session-1', title: 'raw first prompt' as string | null };
  const sessions = {
    getBySessionId: vi.fn(async () => row as never),
    rename: vi.fn(async ({ title: renamed }: { sessionId: string; title: string }) => {
      row.title = renamed;
      return row as never;
    }),
  };
  return {
    channel,
    settings,
    row,
    sessions,
    emitted,
    emit,
    setStoredTitle: (next: string) => (title = next),
    title: () => title,
  };
}

describe('observeClaudeThreadTitle', () => {
  it('names an untitled chat thread from its conversation after its first run, and the session row follows', async () => {
    const fake = fakeChannel();
    const generate = vi.fn(async () => {
      // The controller stores the title it generates itself.
      fake.setStoredTitle('Fix the login redirect');
      return 'Fix the login redirect';
    });
    observeClaudeThreadTitle(fake.channel, { sourceControl: { sessions: fake.sessions }, generate });

    fake.emit({ type: 'agent_start' });
    fake.emit({ type: 'agent_end', reason: 'complete' });
    await vi.waitFor(() => expect(fake.row.title).toBe('Fix the login redirect'));
    expect(generate).toHaveBeenCalledWith('session-1');
    expect(fake.emitted).toContainEqual({ type: 'thread_title_updated', threadId: 'session-1', title: 'Fix the login redirect' });

    // Named once: later runs leave the title alone.
    fake.emit({ type: 'agent_end', reason: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('names a card’s thread after its work item when the run starts, as the Mastra start does', async () => {
    const fake = fakeChannel();
    const generate = vi.fn(async () => 'never asked');
    observeClaudeThreadTitle(fake.channel, { sourceControl: { sessions: fake.sessions }, generate });
    // The start coordinator records the title after the session exists, before its run.
    fake.settings[CLAUDE_THREAD_SETTINGS.title] = '#12 Add CSV export';

    fake.emit({ type: 'agent_start' });
    await vi.waitFor(() => expect(fake.title()).toBe('#12 Add CSV export'));
    await vi.waitFor(() => expect(fake.row.title).toBe('#12 Add CSV export'));

    fake.emit({ type: 'agent_end', reason: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(generate).not.toHaveBeenCalled();

    // A later start with another work item renames it.
    fake.settings[CLAUDE_THREAD_SETTINGS.title] = '#13 Ship it';
    fake.emit({ type: 'agent_start' });
    await vi.waitFor(() => expect(fake.row.title).toBe('#13 Ship it'));
  });

  it('keeps a title given since the start after a restart', async () => {
    const fake = fakeChannel({ title: 'Renamed by hand', startTitle: '#12 Add CSV export' });
    observeClaudeThreadTitle(fake.channel, { sourceControl: { sessions: fake.sessions } });

    fake.emit({ type: 'agent_start' });
    fake.emit({ type: 'agent_end', reason: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fake.title()).toBe('Renamed by hand');
    expect(fake.sessions.rename).not.toHaveBeenCalled();
  });

  it('mirrors a title given to the thread some other way onto the session row', async () => {
    const fake = fakeChannel();
    observeClaudeThreadTitle(fake.channel, { sourceControl: { sessions: fake.sessions } });
    await fake.channel.nameThread('Named elsewhere');
    await vi.waitFor(() => expect(fake.sessions.rename).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Named elsewhere' }));
  });
});
