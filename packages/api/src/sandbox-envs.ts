import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { AuditEmitter, EmitAuditInput } from '@factory/feed';
import type { FactoryProjectsStorage } from '@factory/store';
import type { SandboxEnvFileMetadata, SandboxEnvMetadata, SandboxEnvStore } from '@factory/store';
import { SandboxEnvFilePathTakenError } from '@factory/store';
import { FACTORY_ROUTE_CONTRACTS, UUID_PATTERN } from '@factory/contracts';
import type { RouteDependencies } from '@factory/http';
import { declareAccess, Route } from '@factory/http';
import type { RouteAccess } from '@factory/http';

const UUID_RE = new RegExp(UUID_PATTERN);

function loose(context: unknown): Context {
  return context as Context;
}

export interface SandboxEnvRoutesDeps extends RouteDependencies {
  projects: Pick<FactoryProjectsStorage, 'get'>;
  sandboxEnvs: SandboxEnvStore;
  /**
   * False when auth is on but no secret encryption is configured: values would
   * be stored as plaintext, so writes are refused and the UI says why.
   */
  writable: boolean;
  audit?: AuditEmitter;
  /**
   * Whether a repository link belongs to the Factory, so an env file can only
   * name one of its own repositories. Absent: any id is accepted.
   */
  isProjectRepository?: (scope: { orgId: string; projectId: string; projectRepositoryId: string }) => Promise<boolean>;
  /** Called after a variable changed; Build variables are part of the environment template. */
  onEnvironmentSaved?: (projectId: string) => void;
}

type Resolved = { orgId: string; userId: string; projectId: string };

function payload(env: SandboxEnvMetadata) {
  return {
    name: env.name,
    appliesTo: env.appliesTo,
    stage: env.stage,
    updatedAt: env.updatedAt.toISOString(),
    updatedBy: env.updatedBy,
  };
}

/** An env file without its content: the only shape lists and writes return. */
function filePayload(file: SandboxEnvFileMetadata) {
  return {
    id: file.id,
    projectRepositoryId: file.projectRepositoryId,
    path: file.path,
    stage: file.stage,
    size: file.size,
    updatedAt: file.updatedAt.toISOString(),
    updatedBy: file.updatedBy,
  };
}

/**
 * Factory-wide sandbox environment variables, the stages sandboxes get and
 * the env files written into each repository's checkout. Variable values go
 * in through PUT and never come back out. Env file contents come back only to
 * an organization admin asking for one file (reveal); lists carry paths,
 * stages and sizes. Changing the stages or any env file takes an admin. No
 * response may be cached.
 */
export class SandboxEnvRoutes extends Route<SandboxEnvRoutesDeps> {
  async #resolve(context: Context): Promise<Resolved | { response: Response }> {
    await this.deps.auth.ensureUser(context);
    const tenant = this.deps.auth.tenant(context);
    if (!tenant) return { response: context.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return {
        response: context.json(
          { error: 'organization_required', message: 'Factory projects require an organization.' },
          403,
        ),
      };
    }
    const projectId = context.req.param('id');
    if (!projectId || !UUID_RE.test(projectId)) return { response: context.json({ error: 'Project not found' }, 404) };
    const project = await this.deps.projects.get({ orgId: tenant.orgId, id: projectId });
    if (!project) return { response: context.json({ error: 'Project not found' }, 404) };
    return { orgId: tenant.orgId, userId: tenant.userId, projectId };
  }

  /** Organization admins only, in tenant mode; local (no-auth) mode is a single operator. */
  async #isAdmin(context: Context, scope: Resolved): Promise<boolean> {
    return !this.deps.auth.enabled() || (await this.deps.auth.can(context, 'factory.manage', scope.orgId));
  }

  #adminRequired(context: Context): Response {
    return context.json(
      {
        error: 'organization_admin_required',
        message: 'Organization administrator access is required to change sandbox stages and env files.',
      },
      403,
    );
  }

  #fileId(context: Context): string | undefined {
    const parsed = FACTORY_ROUTE_CONTRACTS.projectSandboxEnvFileGet.pathSchema.safeParse(context.req.param());
    return parsed.success ? parsed.data.fileId : undefined;
  }

  /** Validates the `:name` param; the schema names why a name is refused. */
  #name(context: Context): { name: string } | { response: Response } {
    const parsed = FACTORY_ROUTE_CONTRACTS.projectSandboxEnvSet.pathSchema.safeParse(context.req.param());
    if (parsed.success) return { name: parsed.data.name };
    const issue = parsed.error.issues.find(candidate => candidate.path[0] === 'name') ?? parsed.error.issues[0];
    const name = context.req.param('name') ?? '';
    return {
      response: context.json({ error: 'invalid_name', message: `${name}: ${issue?.message ?? 'Invalid name.'}` }, 400),
    };
  }

  async #body(context: Context): Promise<{ body: unknown } | { response: Response }> {
    const type = context.req.header('content-type') ?? '';
    if (!/^application\/json\b/i.test(type)) {
      return { response: context.json({ error: 'unsupported_media_type' }, 415) };
    }
    try {
      return { body: await context.req.json() };
    } catch {
      return { response: context.json({ error: 'invalid_body' }, 400) };
    }
  }

  /** Audit is best-effort: an event the mirror rejects must never fail the write. */
  async #audit(context: Context, scope: Resolved, input: Omit<EmitAuditInput, 'factoryProjectId'>) {
    try {
      await this.deps.audit?.emit({ context, input: { ...input, factoryProjectId: scope.projectId } });
    } catch (error) {
      console.warn('[factory] Failed to record sandbox env audit event', {
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #route(
    contract: { path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' },
    handle: (context: Context, scope: Resolved) => Promise<Response>,
  ): ApiRoute {
    return registerApiRoute(contract.path, {
      method: contract.method,
      requiresAuth: false,
      handler: async routeContext => {
        const context = loose(routeContext);
        const scope = await this.#resolve(context);
        const response = 'response' in scope ? scope.response : await handle(context, scope);
        response.headers.set('Cache-Control', 'no-store');
        return response;
      },
    });
  }

  routes(): ApiRoute[] {
    return declareAccess(this.#undeclaredRoutes(), ROUTE_ACCESS);
  }

  #undeclaredRoutes(): ApiRoute[] {
    const contracts = FACTORY_ROUTE_CONTRACTS;
    const refused = (context: Context) =>
      context.json(
        {
          error: 'encryption_not_configured',
          message: 'Configure a credential encryption key before saving sandbox environment variables.',
        },
        409,
      );
    return [
      this.#route(contracts.projectSandboxEnvsList, async (context, scope) => {
        const [envs, stages] = await Promise.all([
          this.deps.sandboxEnvs.list(scope.orgId, scope.projectId),
          this.deps.sandboxEnvs.stages(scope.orgId, scope.projectId),
        ]);
        return context.json({
          envs: envs.map(payload),
          writable: this.deps.writable,
          stages,
          canManage: await this.#isAdmin(context, scope),
        });
      }),
      this.#route(contracts.projectSandboxEnvSet, async (context, scope) => {
        const name = this.#name(context);
        if ('response' in name) return name.response;
        if (!this.deps.writable) return refused(context);
        const body = await this.#body(context);
        if ('response' in body) return body.response;
        const parsed = contracts.projectSandboxEnvSet.bodySchema.safeParse(body.body);
        if (!parsed.success) {
          return context.json({ error: 'invalid_sandbox_env', message: parsed.error.issues[0]?.message }, 400);
        }
        const env = await this.deps.sandboxEnvs.set(
          scope.orgId,
          scope.projectId,
          {
            name: name.name,
            value: parsed.data.value,
            appliesTo: parsed.data.appliesTo,
            ...(parsed.data.stage ? { stage: parsed.data.stage } : {}),
          },
          scope.userId,
        );
        await this.#audit(context, scope, {
          action: 'factory.sandbox_env.set',
          targets: [{ type: 'sandbox_env', id: env.name, name: env.name }],
          metadata: { appliesTo: env.appliesTo, stage: env.stage },
        });
        this.deps.onEnvironmentSaved?.(scope.projectId);
        return context.json({ env: payload(env) });
      }),
      this.#route(contracts.projectSandboxEnvUpdate, async (context, scope) => {
        const name = this.#name(context);
        if ('response' in name) return name.response;
        if (!this.deps.writable) return refused(context);
        const body = await this.#body(context);
        if ('response' in body) return body.response;
        const parsed = contracts.projectSandboxEnvUpdate.bodySchema.safeParse(body.body);
        if (!parsed.success) {
          return context.json({ error: 'invalid_sandbox_env', message: parsed.error.issues[0]?.message }, 400);
        }
        const env = await this.deps.sandboxEnvs.update(
          scope.orgId,
          scope.projectId,
          name.name,
          {
            ...(parsed.data.appliesTo ? { appliesTo: parsed.data.appliesTo } : {}),
            ...(parsed.data.stage ? { stage: parsed.data.stage } : {}),
          },
          scope.userId,
        );
        if (!env) return context.json({ error: 'Variable not found', message: 'Variable not found.' }, 404);
        await this.#audit(context, scope, {
          action: 'factory.sandbox_env.updated',
          targets: [{ type: 'sandbox_env', id: env.name, name: env.name }],
          metadata: { appliesTo: env.appliesTo, stage: env.stage },
        });
        this.deps.onEnvironmentSaved?.(scope.projectId);
        return context.json({ env: payload(env) });
      }),
      this.#route(contracts.projectSandboxEnvDelete, async (context, scope) => {
        const name = this.#name(context);
        if ('response' in name) return name.response;
        // Deleting stays allowed without encryption, so a plaintext value can always be removed.
        if (!(await this.deps.sandboxEnvs.delete(scope.orgId, scope.projectId, name.name))) {
          return context.json({ error: 'Variable not found', message: 'Variable not found.' }, 404);
        }
        await this.#audit(context, scope, {
          action: 'factory.sandbox_env.deleted',
          targets: [{ type: 'sandbox_env', id: name.name, name: name.name }],
        });
        this.deps.onEnvironmentSaved?.(scope.projectId);
        return context.body(null, 204);
      }),
      this.#route(contracts.projectSandboxStagesSet, async (context, scope) => {
        if (!(await this.#isAdmin(context, scope))) return this.#adminRequired(context);
        const body = await this.#body(context);
        if ('response' in body) return body.response;
        const parsed = contracts.projectSandboxStagesSet.bodySchema.safeParse(body.body);
        if (!parsed.success) {
          return context.json({ error: 'invalid_sandbox_stages', message: parsed.error.issues[0]?.message }, 400);
        }
        const stages = await this.deps.sandboxEnvs.setStages(
          scope.orgId,
          scope.projectId,
          parsed.data.stages,
          scope.userId,
        );
        await this.#audit(context, scope, {
          action: 'factory.sandbox_env.stages_updated',
          targets: [{ type: 'factory_project', id: scope.projectId }],
          metadata: { stages },
        });
        return context.json({ stages });
      }),
      this.#route(contracts.projectSandboxEnvFilesList, async (context, scope) => {
        const files = await this.deps.sandboxEnvs.listFiles(scope.orgId, scope.projectId);
        return context.json({
          files: files.map(filePayload),
          writable: this.deps.writable,
          canManage: await this.#isAdmin(context, scope),
        });
      }),
      this.#route(contracts.projectSandboxEnvFileGet, async (context, scope) => {
        if (!(await this.#isAdmin(context, scope))) return this.#adminRequired(context);
        const fileId = this.#fileId(context);
        const file = fileId ? await this.deps.sandboxEnvs.getFile(scope.orgId, scope.projectId, fileId) : null;
        if (!file) return context.json({ error: 'Env file not found', message: 'Env file not found.' }, 404);
        return context.json({ file: { ...filePayload(file), content: file.content } });
      }),
      this.#route(contracts.projectSandboxEnvFileCreate, async (context, scope) => {
        if (!(await this.#isAdmin(context, scope))) return this.#adminRequired(context);
        if (!this.deps.writable) return refused(context);
        const body = await this.#body(context);
        if ('response' in body) return body.response;
        const parsed = contracts.projectSandboxEnvFileCreate.bodySchema.safeParse(body.body);
        if (!parsed.success) {
          return context.json({ error: 'invalid_env_file', message: parsed.error.issues[0]?.message }, 400);
        }
        const projectRepositoryId = parsed.data.projectRepositoryId;
        if (
          this.deps.isProjectRepository &&
          !(await this.deps.isProjectRepository({ orgId: scope.orgId, projectId: scope.projectId, projectRepositoryId }))
        ) {
          return context.json({ error: 'Repository not found', message: 'Repository not found in this Factory.' }, 404);
        }
        try {
          const file = await this.deps.sandboxEnvs.createFile(scope.orgId, scope.projectId, parsed.data, scope.userId);
          await this.#audit(context, scope, {
            action: 'factory.sandbox_env.file_created',
            targets: [{ type: 'sandbox_env_file', id: file.id, name: file.path }],
            metadata: { projectRepositoryId, stage: file.stage },
          });
          return context.json({ file: filePayload(file) });
        } catch (error) {
          if (error instanceof SandboxEnvFilePathTakenError) {
            return context.json({ error: 'env_file_path_taken', message: error.message }, 409);
          }
          throw error;
        }
      }),
      this.#route(contracts.projectSandboxEnvFileUpdate, async (context, scope) => {
        if (!(await this.#isAdmin(context, scope))) return this.#adminRequired(context);
        if (!this.deps.writable) return refused(context);
        const fileId = this.#fileId(context);
        if (!fileId) return context.json({ error: 'Env file not found', message: 'Env file not found.' }, 404);
        const body = await this.#body(context);
        if ('response' in body) return body.response;
        const parsed = contracts.projectSandboxEnvFileUpdate.bodySchema.safeParse(body.body);
        if (!parsed.success) {
          return context.json({ error: 'invalid_env_file', message: parsed.error.issues[0]?.message }, 400);
        }
        const patch = {
          ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
          ...(parsed.data.stage !== undefined ? { stage: parsed.data.stage } : {}),
          ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
        };
        try {
          const file = await this.deps.sandboxEnvs.updateFile(scope.orgId, scope.projectId, fileId, patch, scope.userId);
          if (!file) return context.json({ error: 'Env file not found', message: 'Env file not found.' }, 404);
          await this.#audit(context, scope, {
            action: 'factory.sandbox_env.file_updated',
            targets: [{ type: 'sandbox_env_file', id: file.id, name: file.path }],
            metadata: { stage: file.stage, contentChanged: patch.content !== undefined },
          });
          return context.json({ file: filePayload(file) });
        } catch (error) {
          if (error instanceof SandboxEnvFilePathTakenError) {
            return context.json({ error: 'env_file_path_taken', message: error.message }, 409);
          }
          throw error;
        }
      }),
      this.#route(contracts.projectSandboxEnvFileDelete, async (context, scope) => {
        if (!(await this.#isAdmin(context, scope))) return this.#adminRequired(context);
        const fileId = this.#fileId(context);
        // Deleting stays allowed without encryption, like variables.
        if (!fileId || !(await this.deps.sandboxEnvs.deleteFile(scope.orgId, scope.projectId, fileId))) {
          return context.json({ error: 'Env file not found', message: 'Env file not found.' }, 404);
        }
        await this.#audit(context, scope, {
          action: 'factory.sandbox_env.file_deleted',
          targets: [{ type: 'sandbox_env_file', id: fileId }],
        });
        return context.body(null, 204);
      }),
    ];
  }
}

/** What each route that changes something needs (ADR-0045, `@factory/access`). */
const ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'PUT /web/factory/projects/:id/sandbox-envs/:name': 'factory.manage',
  'PATCH /web/factory/projects/:id/sandbox-envs/:name': 'factory.manage',
  'DELETE /web/factory/projects/:id/sandbox-envs/:name': 'factory.manage',
  'PUT /web/factory/projects/:id/sandbox-stages': 'factory.manage',
  'POST /web/factory/projects/:id/sandbox-env-files': 'factory.manage',
  'PATCH /web/factory/projects/:id/sandbox-env-files/:fileId': 'factory.manage',
  'DELETE /web/factory/projects/:id/sandbox-env-files/:fileId': 'factory.manage',
};
