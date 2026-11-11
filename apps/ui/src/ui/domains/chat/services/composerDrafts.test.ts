import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composerDraftKey, loadComposerDraft, saveComposerDraft } from './composerDrafts';

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.#items.set(key, value);
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  get size() {
    return this.#items.size;
  }
}

const globals = globalThis as { localStorage?: unknown };
let storage: MemoryStorage;

describe('composer drafts', () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    globals.localStorage = storage;
  });
  afterEach(() => {
    delete globals.localStorage;
  });

  it('keeps each thread apart and gives its text back', () => {
    saveComposerDraft(composerDraftKey('session-1', 'thread-1'), 'half a thought');
    saveComposerDraft(composerDraftKey('session-2', undefined), 'another');

    expect(loadComposerDraft(composerDraftKey('session-1', 'thread-1'))).toBe('half a thought');
    expect(loadComposerDraft(composerDraftKey('session-2', undefined))).toBe('another');
    expect(loadComposerDraft(composerDraftKey('session-1', 'thread-2'))).toBe('');
  });

  it('removes the draft once it is sent or emptied', () => {
    const key = composerDraftKey('session-1', 'thread-1');
    saveComposerDraft(key, 'send me');
    saveComposerDraft(key, '   ');

    expect(storage.size).toBe(0);
    expect(loadComposerDraft(key)).toBe('');
  });

  it('works without storage or when storage refuses', () => {
    delete globals.localStorage;
    expect(() => saveComposerDraft('k', 'text')).not.toThrow();
    expect(loadComposerDraft('k')).toBe('');

    globals.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveComposerDraft('k', 'text')).not.toThrow();
    expect(loadComposerDraft('k')).toBe('');
  });
});
