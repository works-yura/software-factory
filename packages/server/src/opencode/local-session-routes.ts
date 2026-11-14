/**
 * The person's own OpenCode sessions, continued in the Factory (ADR-0043, amendment). Offered only
 * where the server runs on the person's own machine (the routes are absent elsewhere): the list
 * reads their OpenCode database read-only; an import reads one session's history first, and only then
 * creates a personal session on the repository they chose (on the OpenCode harness) and writes the
 * history into it. Nothing is written to the person's OpenCode, and no agent reads it.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { createImportedTurnSession, resolveOrgTenant } from '@factory/api';
import type { SourceControlSessionRoutesOptions } from '@factory/api';

/** One of the person's OpenCode sessions, as the list reads it. */
export interface OpenCodeLocalSessionItem {
  id: string;
  title: string;
  directory: string;
  worktree?: string;
  updatedAt: string;
  messages: number;
  /** `owner/name` of the folder's git `origin`, when it is a clone. */
  repositorySlug?: string;
}

/** A read session's history, opaque to the routes. */
export interface OpenCodeLocalSessionHistory {
  title: string;
  directory: string;
  turns: number;
}

/** The server's reader and writer of the person's OpenCode sessions. */
export interface OpenCodeLocalSessionsService<History extends OpenCodeLocalSessionHistory = OpenCodeLocalSessionHistory> {
  list(): Promise<OpenCodeLocalSessionItem[]>;
  read(openCodeSessionId: string): Promise<History>;
  write(sessionId: string, history: History): Promise<void>;
}

export interface OpenCodeLocalSessionRoutesOptions extends SourceControlSessionRoutesOptions {
  /** Present only where the server is the person's own machine. */
  opencodeLocalSessions?: OpenCodeLocalSessionsService<OpenCodeLocalSessionHistory>;
}

/** A Factory repository a session can continue on, with its `owner/name` to match a folder against. */
interface RepositoryChoice {
  projectRepositoryId: string;
  slug: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The Factory's repositories, by `owner/name`. */
async function factoryRepositories(options: SourceControlSessionRoutesOptions, orgId: string, factoryProjectId: string): Promise<RepositoryChoice[]> {
  const lists = await Promise.all(
    options.sourceControls.map(async sourceControl => {
      const links = await sourceControl.projectRepositories.listByProject({ orgId, factoryProjectId });
      const choices = await Promise.all(
        links.map(async link => {
          const repository = await sourceControl.repositories.get({ orgId, id: link.repositoryId });
          return repository ? { projectRepositoryId: link.id, slug: repository.slug } : null;
        }),
      );
      return choices.filter((choice): choice is RepositoryChoice => choice !== null);
    }),
  );
  return lists.flat();
}

export function buildOpenCodeLocalSessionRoutes(options: OpenCodeLocalSessionRoutesOptions): ApiRoute[] {
  const service = options.opencodeLocalSessions;
  if (!service) return [];
  return [
    registerApiRoute('/web/opencode/local-sessions', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(c as Context, options.auth);
        if ('response' in resolved) return resolved.response;
        const factoryProjectId = c.req.query('factoryProjectId');
        if (!factoryProjectId) return c.json({ error: 'factoryProjectId is required' }, 400);
        const project = await options.projects.get({ orgId: resolved.tenant.orgId, id: factoryProjectId });
        if (!project) return c.json({ error: 'Factory not found' }, 404);
        const repositories = await factoryRepositories(options, resolved.tenant.orgId, project.id);
        let sessions: OpenCodeLocalSessionItem[];
        try {
          sessions = await service.list();
        } catch (error) {
          return c.json({ error: 'unreadable', message: message(error) }, 409);
        }
        const bySlug = new Map(repositories.map(choice => [choice.slug.toLowerCase(), choice]));
        return c.json({
          repositories,
          sessions: sessions.map(session => {
            const match = session.repositorySlug ? bySlug.get(session.repositorySlug.toLowerCase()) : undefined;
            return { ...session, ...(match ? { projectRepositoryId: match.projectRepositoryId } : {}) };
          }),
        });
      },
    }),
    registerApiRoute('/web/opencode/local-sessions/:openCodeSessionId/import', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(c as Context, options.auth);
        if ('response' in resolved) return resolved.response;
        const { orgId, userId } = resolved.tenant;
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: 'Invalid JSON body' }, 400);
        }
        const { projectRepositoryId, visibility } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        if (typeof projectRepositoryId !== 'string' || !projectRepositoryId) return c.json({ error: 'projectRepositoryId is required' }, 400);
        if (visibility !== undefined && visibility !== 'private' && visibility !== 'org') return c.json({ error: "visibility must be 'private' or 'org'" }, 400);
        // Read first: nothing is created when the history cannot be read.
        let history: OpenCodeLocalSessionHistory;
        try {
          history = await service.read(c.req.param('openCodeSessionId'));
        } catch (error) {
          return c.json({ error: 'unreadable', message: message(error) }, 409);
        }
        const created = await createImportedTurnSession(options, { harness: 'opencode', unavailableError: 'opencode_unavailable' }, {
          orgId,
          userId,
          projectRepositoryId,
          title: history.title,
          visibility: visibility ?? 'private',
        });
        if ('status' in created) return c.json({ error: created.error, message: created.message }, created.status);
        try {
          await service.write(created.session.sessionId, history);
        } catch (error) {
          // The session stays (empty) so nothing is lost silently; the person sees why and may delete it.
          return c.json({ error: 'import_failed', message: message(error), session: created.payload }, 500);
        }
        return c.json({ session: created.payload, imported: { turns: history.turns } });
      },
    }),
  ];
}
