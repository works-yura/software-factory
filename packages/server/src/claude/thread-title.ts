import type { AgentControllerEvent, AgentControllerThread } from '@mastra/core/agent-controller';

import { normalizeSessionTitle, observeSessionThreadTitle, type ThreadTitleMirrorDependencies } from '@factory/session';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

/** What naming a Claude Code session's thread needs of its chat channel (`ClaudeSessionUiChannel`). */
export interface ClaudeTitleChannel {
  readonly session: {
    readonly id: string;
    readonly thread: { getSetting(args: { key: string }): Promise<unknown> };
  };
  readonly threadId: string;
  subscribe(listener: (event: AgentControllerEvent) => void): () => void;
  emit(event: AgentControllerEvent): void;
  /** Stores the title and announces it (`thread_title_updated`); `false` when the title already stood. */
  nameThread(title: string): Promise<boolean>;
  threadTitle(): Promise<string>;
  getThread(threadId: string): Promise<AgentControllerThread | null>;
}

export interface ClaudeThreadTitleDependencies extends ThreadTitleMirrorDependencies {
  /**
   * Names the thread from its conversation and stores the title, as the Mastra
   * controller's `generateThreadTitle` does; `undefined` when the model gave
   * nothing. Without it a chat thread keeps no title until it is named by hand.
   */
  generate?: (threadId: string) => Promise<string | undefined>;
}

function settingTitle(value: unknown): string | null {
  return typeof value === 'string' ? normalizeSessionTitle(value) : null;
}

/**
 * Gives a Claude Code session's thread the title a Mastra session's thread
 * gets, and mirrors it onto the session row the sidebar reads
 * ({@link observeSessionThreadTitle}, as for a Mastra session):
 *
 * - a card's start names the thread after its work item, as the Mastra start
 *   coordinator renames it: the start leaves the title in the thread's
 *   `factoryThreadTitle` setting, applied when the run starts, if the thread
 *   has no title yet or the start brought a new one;
 * - otherwise the first run that ends with the thread still untitled names it
 *   from the conversation, as Mastra memory's `generateTitle` names a thread
 *   after its first turn. Tried once per session object.
 */
export function observeClaudeThreadTitle(
  channel: ClaudeTitleChannel,
  { sourceControl, generate }: ClaudeThreadTitleDependencies,
): () => void {
  const stopMirror = observeSessionThreadTitle(
    {
      identity: { getId: () => channel.session.id },
      thread: { getById: ({ threadId }) => channel.getThread(threadId) },
      subscribe: listener => channel.subscribe(listener),
    },
    { sourceControl },
  );

  // The start's title as this process first saw it: a restart does not undo a rename made since.
  const seen = channel.session.thread
    .getSetting({ key: CLAUDE_THREAD_SETTINGS.title })
    .then(settingTitle)
    .catch(() => null);
  let applied: string | null | undefined;
  let generated = false;
  let naming: Promise<void> = Promise.resolve();
  const queue = (step: () => Promise<void>) => {
    naming = naming
      .then(step)
      .catch(error => console.warn('[factory] Could not name a Claude Code thread', error));
  };

  const nameFromStart = async () => {
    applied ??= await seen;
    const title = settingTitle(await channel.session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.title }));
    if (!title) return;
    const fresh = title !== applied;
    applied = title;
    if (fresh || !(await channel.threadTitle())) await channel.nameThread(title);
  };

  const nameFromConversation = async () => {
    if (generated || !generate || (await channel.threadTitle())) return;
    generated = true;
    const threadId = channel.threadId;
    const raw = await generate(threadId);
    const title = raw ? normalizeSessionTitle(raw) : null;
    if (!title) return;
    // The generator stored the title itself; the streams and the mirror still need to hear it.
    if (!(await channel.nameThread(title))) channel.emit({ type: 'thread_title_updated', threadId, title });
  };

  const stopNaming = channel.subscribe(event => {
    if (event.type === 'agent_start') queue(nameFromStart);
    else if (event.type === 'agent_end') queue(nameFromConversation);
  });

  return () => {
    stopNaming();
    stopMirror();
  };
}
