/**
 * Continuing the person's own OpenCode sessions in the Factory (ADR-0043, amendment): on the person's
 * own machine only, at their request, their OpenCode database (`~/.local/share/opencode/opencode.db`)
 * is opened read-only by the server (never by an agent, never by OpenCode itself), a session's
 * history is read, and it is written into a new Factory session on the OpenCode harness. The
 * Factory session's first turn starts a new OpenCode conversation that carries that history
 * (a context handoff, as after a resume failed).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  listLocalOpenCodeSessions,
  localOpenCodeDatabasePath,
  readLocalOpenCodeSession,
  type LocalOpenCodeSessionHistory,
  type OpenCodeHarness,
} from '@factory/harness-opencode';

const run = promisify(execFile);

/** One of the person's OpenCode sessions as the import list shows it, with the repository its folder is a clone of. */
export interface OpenCodeLocalSessionView {
  id: string;
  title: string;
  directory: string;
  worktree?: string;
  updatedAt: string;
  messages: number;
  /** `owner/name` of the folder's `origin` remote, when it is a git clone with one. */
  repositorySlug?: string;
}

/** A read session, ready to be written: its history, and how much of it there is. */
export interface OpenCodeLocalHistory {
  title: string;
  directory: string;
  turns: number;
  readonly history: LocalOpenCodeSessionHistory;
}

export interface OpenCodeLocalSessions {
  list(): Promise<OpenCodeLocalSessionView[]>;
  /** Reads a session's history; throws with why when it cannot (no database, no such session). */
  read(openCodeSessionId: string): Promise<OpenCodeLocalHistory>;
  /** Writes read history into a Factory session the OpenCode harness holds, which has not run yet. */
  write(sessionId: string, history: OpenCodeLocalHistory): Promise<void>;
}

/**
 * `owner/name` from a git remote URL (`git@github.com:owner/name.git`, `https://host/owner/name`,
 * a GitLab subgroup path), or undefined when it is not one.
 */
export function remoteSlug(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(trimmed);
  let path: string | undefined;
  if (scp) path = scp[1];
  else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  const slug = path?.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return slug && slug.includes('/') ? slug : undefined;
}

/** The `origin` remote of a folder, as `owner/name`; undefined when it is not a clone or has none. */
async function folderSlug(directory: string): Promise<string | undefined> {
  if (!directory) return undefined;
  try {
    const { stdout } = await run('git', ['-C', directory, 'remote', 'get-url', 'origin'], { timeout: 5_000 });
    return remoteSlug(stdout);
  } catch {
    return undefined;
  }
}

export function createOpenCodeLocalSessions(options: {
  harness: Pick<OpenCodeHarness, 'getSession'>;
  /** The person's OpenCode database; where OpenCode keeps it for this server's user by default. */
  databasePath?: string;
  /** Resolves once a Factory session's transcript is stored (its chat channel flushed). */
  flushed: (sessionId: string) => Promise<void>;
  /** Marks the thread so its first turn carries the imported history. */
  handOff: (input: { sessionId: string; threadId: string; resourceId: string }) => Promise<void>;
  /** How a folder's repository is named (tests); its git `origin` remote by default. */
  slugOf?: (directory: string) => Promise<string | undefined>;
}): OpenCodeLocalSessions {
  const path = options.databasePath ?? localOpenCodeDatabasePath();
  const slugOf = options.slugOf ?? folderSlug;
  return {
    async list() {
      const sessions = listLocalOpenCodeSessions(path);
      const slugs = new Map<string, Promise<string | undefined>>();
      return Promise.all(
        sessions.map(async session => {
          const folder = session.worktree ?? session.directory;
          let slug = slugs.get(folder);
          if (!slug) {
            slug = slugOf(folder);
            slugs.set(folder, slug);
          }
          const repositorySlug = await slug;
          return { ...session, ...(repositorySlug ? { repositorySlug } : {}) };
        }),
      );
    },

    async read(openCodeSessionId) {
      const history = readLocalOpenCodeSession(path, openCodeSessionId);
      return { title: history.session.title, directory: history.session.directory, turns: history.turns.length, history };
    },

    async write(sessionId, { history }) {
      const session = await options.harness.getSession(sessionId);
      if (!session) throw new Error(`Factory session ${sessionId} is not an OpenCode session.`);
      await session.importHistory(history.turns, {
        openCodeSessionId: history.session.id,
        directory: history.session.directory,
        title: history.session.title,
      });
      await options.flushed(sessionId);
      await options.handOff({
        sessionId,
        threadId: session.thread.requireId(),
        resourceId: session.resourceId ?? sessionId,
      });
    },
  };
}
