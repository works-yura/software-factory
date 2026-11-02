/**
 * Each Claude Code session's own CLI config dir (`CLAUDE_CONFIG_DIR`), so its
 * transcripts, auto-memory and settings never mix with another session's or
 * with the person's own `~/.claude`. The dir is fixed per session (`--resume`
 * finds the session's files there) and removed with the session.
 *
 * Credentials are not kept here: a turn gets them as env from the credentials
 * hook, and the CLI's stored sign-in is pointed at this dir too, so nothing of
 * the person's own login (`~/.claude`, its Keychain item) is ever read.
 *
 * A session that ran on the default `~/.claude` before it had a dir gets one
 * too: its `--resume` id is not found there, so the harness starts it a fresh
 * Claude conversation (the Factory thread keeps its history).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/** What a new dir starts with: without it, a fresh config dir makes the CLI walk through first-run onboarding. */
export const CLAUDE_SESSION_CONFIG_SEED = { hasCompletedOnboarding: true } as const;

export interface ClaudeSessionConfigDirs {
  /** The session's dir, created and seeded on its first turn. */
  dirFor(session: { id: string }): string;
  /** Remove a deleted session's dir; a missing dir is fine. */
  remove(sessionId: string): Promise<void>;
}

/** A name safe on every filesystem, still unique per session id (`factory-supervisor:<id>` has a colon). */
export function claudeSessionConfigName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

export function createClaudeSessionConfigDirs(root: string): ClaudeSessionConfigDirs {
  const pathOf = (sessionId: string) => join(root, claudeSessionConfigName(sessionId));
  return {
    dirFor(session) {
      const dir = pathOf(session.id);
      if (existsSync(dir)) return dir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(join(dir, '.claude.json'), `${JSON.stringify(CLAUDE_SESSION_CONFIG_SEED, null, 2)}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        // Seeded by a turn that got here first.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      return dir;
    },
    async remove(sessionId) {
      await rm(pathOf(sessionId), { recursive: true, force: true });
    },
  };
}
