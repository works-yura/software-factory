/**
 * Notes the sandbox setup leaves for the agent's next turn: its sandbox was
 * restored from saved work, what is gone with the old folder, what to do
 * about a diverged branch (ADR-0039). Every harness renders them in its turn
 * signals (`<factory-sandbox>`); a note stays until a run that showed it
 * ends, so a note queued after a turn's signals were built reaches the next
 * turn instead of being dropped. Kept in memory: a restore re-queues it.
 */

interface QueuedNote {
  text: string;
  shown: boolean;
}

const notes = new Map<string, QueuedNote[]>();

/** Queue a note for the session's next turn. */
export function queueSessionNote(sessionId: string, text: string): void {
  const queued = notes.get(sessionId) ?? [];
  if (!queued.some(note => note.text === text)) queued.push({ text, shown: false });
  notes.set(sessionId, queued);
}

/** The session's notes, marked shown; a harness calls it as it builds a turn's signals. */
export function readSessionNotes(sessionId: string): string[] {
  const queued = notes.get(sessionId);
  if (!queued?.length) return [];
  for (const note of queued) note.shown = true;
  return queued.map(note => note.text);
}

/** A run ended: drop the notes it showed, keep any queued after its signals were built. */
export function settleSessionNotes(sessionId: string): void {
  const left = notes.get(sessionId)?.filter(note => !note.shown) ?? [];
  if (left.length) notes.set(sessionId, left);
  else notes.delete(sessionId);
}

/** The notes as one turn signal, or `undefined` when there are none. */
export function renderSessionNotes(sessionId: string): string | undefined {
  const texts = readSessionNotes(sessionId);
  return texts.length ? `<factory-sandbox>\n${texts.join('\n\n')}\n</factory-sandbox>` : undefined;
}

export function __clearSessionNotesForTests(): void {
  notes.clear();
}

/** What the agent is told once after its sandbox came back from saved work. */
export const RESTORED_SANDBOX_NOTE = [
  'Your sandbox was restored from saved work: its folder had been removed (the sandbox went to sleep, or its card folder was rebuilt), so the repositories were cloned again and your branch put back with its commits and uncommitted changes.',
  'Gone with the old folder: files git ignores (node_modules, build output, local .env and key files, which Factory never saves) and everything that was running (dev servers, watchers, background jobs). The setup commands ran again; restart what you need.',
].join('\n');

/** What the agent is told about one restored repository beyond the general note, if anything. */
export function restoredRepositoryNote(repo: {
  slug: string;
  branch: string;
  diverged?: { saved: string; remote: string };
  unverified?: boolean;
  tree?: 'restored' | 'conflict';
}): string | undefined {
  const lines: string[] = [];
  if (repo.diverged) {
    lines.push(
      `${repo.slug}: your saved commits and the remote branch went apart. ${repo.branch} holds your saved commits (${repo.diverged.saved.slice(0, 12)}); the remote's are at origin/${repo.branch} (${repo.diverged.remote.slice(0, 12)}). Reconcile them with a merge or rebase and say so; never force-push over the remote.`,
    );
  } else if (repo.unverified) {
    lines.push(
      `${repo.slug}: the checkout is too shallow to tell whether origin/${repo.branch} contains your saved commits; ${repo.branch} keeps them. Check before pushing; never force-push.`,
    );
  }
  if (repo.tree === 'conflict') {
    lines.push(
      `${repo.slug}: your saved uncommitted changes no longer apply on ${repo.branch}; the checkout is clean and they are kept in the ref refs/factory/saved-changes (compare with \`git diff HEAD refs/factory/saved-changes\`, take a file with \`git checkout refs/factory/saved-changes -- <path>\`).`,
    );
  }
  return lines.length ? lines.join('\n') : undefined;
}
