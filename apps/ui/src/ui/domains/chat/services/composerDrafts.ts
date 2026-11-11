/**
 * Unsent composer text, kept per chat thread in this browser, so switching sessions and coming
 * back finds what was typed. Text only: attached files and references are not kept.
 *
 * Storage can be missing or refuse (private windows, blocked site data); the composer then works
 * as before, with an empty draft after a switch.
 */

const DRAFT_KEY_PREFIX = 'factory.composerDraft:';

export function composerDraftKey(sessionId: string, threadId: string | undefined): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}:${threadId ?? 'draft'}`;
}

export function loadComposerDraft(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Keeps `text` under `key`; an empty or blank draft removes it. */
export function saveComposerDraft(key: string, text: string): void {
  try {
    if (text.trim()) globalThis.localStorage?.setItem(key, text);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage refused: the draft lives only while this thread stays open.
  }
}
