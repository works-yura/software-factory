// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { composerDraftKey } from '../../services/composerDrafts';
import { ChatCommandsProvider, useChatCommands } from '../ChatCommandsProvider';

function mount(draftKey: string | undefined, initialDraft?: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ChatCommandsProvider draftKey={draftKey} initialDraft={initialDraft}>
      {children}
    </ChatCommandsProvider>
  );
  return renderHook(() => useChatCommands(), { wrapper });
}

describe('composer draft per thread', () => {
  afterEach(() => localStorage.clear());

  it('gives back the unsent text when the person returns to the thread', () => {
    const key = composerDraftKey('session-1', 'thread-1');
    const first = mount(key);
    act(() => first.result.current.setComposerDraft('half a thought'));
    first.unmount();

    const other = mount(composerDraftKey('session-2', 'thread-2'));
    expect(other.result.current.composerDraft).toBe('');
    other.unmount();

    expect(mount(key).result.current.composerDraft).toBe('half a thought');
  });

  it('forgets the draft once it is sent (cleared)', () => {
    const key = composerDraftKey('session-1', undefined);
    const first = mount(key);
    act(() => first.result.current.setComposerDraft('send me'));
    act(() => first.result.current.setComposerDraft(''));
    first.unmount();

    expect(mount(key).result.current.composerDraft).toBe('');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('prefers a message that failed to send over a kept draft', () => {
    const key = composerDraftKey('session-1', 'thread-1');
    localStorage.setItem(key, 'older draft');

    expect(mount(key, 'the failed message').result.current.composerDraft).toBe('the failed message');
  });

  it('keeps the draft in memory only without a key', () => {
    const first = mount(undefined);
    act(() => first.result.current.setComposerDraft('nowhere to keep'));

    expect(localStorage.length).toBe(0);
  });
});
