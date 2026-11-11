// Mastra's model facet (`HarnessModels`): a session's catalog is the one its credentials reach
// (`resolveSessionModelCatalog`, as the Settings picker), its options are the model's thinking
// levels, and a pick switches the live session now or the thread's model for its next run.
import type { AuthStorage } from '@mastra/code-sdk/auth/storage';

import { buildModelCatalog, listSessionScopedCredentials } from '@factory/credentials';
import type { ModelCatalogEntry } from '@factory/credentials';
import {
  MASTRA_DISPLAY_NAME,
  MASTRA_HARNESS_ID,
  MASTRA_INSTANCE_ID,
  mastraModelSelection,
  mastraServerModel,
} from '@factory/credentials/mastra-models';
import type { ModelSelection, ProviderOptionSelection } from '@factory/harness/models/contracts';
import type { HarnessModelContext, HarnessModels, ModelSwitchResult } from '@factory/harness/models/facet';
import { getModelSelectionStringOptionValue } from '@factory/harness/models/model';
import { checkOptionSelections, EFFORT_OPTION_ID } from '@factory/harness/models/selection';
import { externalSessionFor } from '@factory/integrations';
import { resolveSessionModelCatalog, unrunnableModelMessage } from '@factory/session';
import type { SessionModelCatalog, SessionModelCatalogDependencies, SourceControlSessionLookup } from '@factory/session';
import type { FactoryProjectsStorage, WorkItemsStorage } from '@factory/store';

import { resolveSessionThread } from './tools/deliver.ts';
import type { FactoryMessaging } from './tools/messaging-tools.ts';

export interface MastraHarnessModelsDependencies {
  /** The live controller; resolved per call because it exists only once the mount is up. */
  messaging: () => Promise<Pick<FactoryMessaging, 'controller'> | null>;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  workItems: Pick<WorkItemsStorage, 'findActiveRunBindingForSession' | 'hasRunBindingForSession' | 'findRunBindingByThread'>;
  sessionModel: {
    projects: Pick<FactoryProjectsStorage, 'getById' | 'get'>;
    tenantCatalog?: SessionModelCatalogDependencies['tenantCatalog'];
    authStorage?: () => AuthStorage | undefined;
  };
}

/** Thrown inside the facet and answered as a refusal with its status. */
class MastraModelError extends Error {
  readonly status: 400 | 404 | 503;
  constructor(status: 400 | 404 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The Mastra harness's models. It answers for every session no other harness owns (sessions
 * `routeExternalSessions` hands to another harness are not its own), so register it as the
 * registry's fallback.
 */
export function createMastraHarnessModels(deps: MastraHarnessModelsDependencies): HarnessModels {
  const controllerOrThrow = async () => {
    const controller = (await deps.messaging())?.controller;
    if (!controller) throw new MastraModelError(503, 'Session model switching is not available on this server.');
    return controller;
  };

  /** The session's thread and resource: its run binding's, its live thread, else its newest. */
  const sessionThread = async (sessionId: string) => {
    const controller = await controllerOrThrow();
    const threadId = await resolveSessionThread({ controller, sessions: deps.sessions, workItems: deps.workItems, sessionId });
    // The thread's resource, not the session id: sessions share their Factory's or owner's resource.
    const resourceId = threadId ? ((await controller.queryThreadById({ threadId }))?.resourceId ?? sessionId) : sessionId;
    return { controller, threadId, resourceId };
  };

  const sessionCatalog = async (sessionId: string, ctx: HarnessModelContext): Promise<SessionModelCatalog> => {
    const { controller, threadId, resourceId } = await sessionThread(sessionId);
    return resolveSessionModelCatalog(
      controller,
      { sessionId, threadId: threadId ?? sessionId, resourceId },
      ctx.viewer,
      {
        projects: deps.sessionModel.projects,
        sourceControl: deps.sessions,
        workItems: deps.workItems,
        ...(deps.sessionModel.authStorage ? { authStorage: deps.sessionModel.authStorage } : {}),
        ...(deps.sessionModel.tenantCatalog ? { tenantCatalog: deps.sessionModel.tenantCatalog } : {}),
      },
    );
  };

  /** Outside a session: the server's keys, or the viewer's organization credentials. */
  const viewerCatalog = async (ctx: HarnessModelContext): Promise<ModelCatalogEntry[]> => {
    const controller = await controllerOrThrow();
    const authStorage = deps.sessionModel.authStorage?.();
    const tenant = deps.sessionModel.tenantCatalog;
    if (!tenant || !ctx.viewer.orgId) return buildModelCatalog({ controller, ...(authStorage ? { authStorage } : {}) });
    const customProviders = tenant.customProviders;
    return buildModelCatalog({
      controller,
      ...(authStorage ? { authStorage } : {}),
      tenantCredentials: await listSessionScopedCredentials({ credentials: tenant.credentials, ...ctx.viewer }),
      deploymentProviders: tenant.deploymentProviders,
      listCustomProviders: customProviders
        ? async () => {
            await customProviders.ensureReady();
            return customProviders.list({ orgId: ctx.viewer.orgId });
          }
        : undefined,
    });
  };

  const liveSelection = async (sessionId: string): Promise<ModelSelection | null> => {
    const controller = await controllerOrThrow();
    const live = await controller.getSession(sessionId);
    const modelId = live?.model.get();
    if (!live || !modelId) return null;
    const state = live.state?.get() as { thinkingLevel?: unknown } | undefined;
    return mastraModelSelection(modelId, typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null);
  };

  /** A session's live pick; outside one, its Factory's default model. */
  const defaultSelection = async (ctx: HarnessModelContext): Promise<ModelSelection | null> => {
    if (ctx.sessionId) return liveSelection(ctx.sessionId);
    if (!ctx.factoryProjectId) return null;
    const project = await deps.sessionModel.projects.getById({ id: ctx.factoryProjectId });
    return project?.defaultModelId ? mastraModelSelection(project.defaultModelId) : null;
  };

  const refusal = (error: unknown): ModelSwitchResult => {
    if (error instanceof MastraModelError) return { ok: false, status: error.status, error: error.message };
    throw error;
  };

  return {
    instanceId: MASTRA_INSTANCE_ID,
    harnessId: MASTRA_HARNESS_ID,
    displayName: MASTRA_DISPLAY_NAME,
    async owns(sessionId) {
      const controller = (await deps.messaging())?.controller;
      return !controller || !(await externalSessionFor(controller, sessionId));
    },
    async list(ctx) {
      const defaultModelId = (await defaultSelection(ctx))?.model ?? null;
      const models = ctx.sessionId ? (await sessionCatalog(ctx.sessionId, ctx)).models : await viewerCatalog(ctx);
      return models.map(entry => mastraServerModel(entry, defaultModelId));
    },
    defaultSelection,
    // A model the session's credentials run, and options among its own: its thinking level is `effort`.
    async check(request, ctx) {
      if (!ctx.sessionId) return { ok: false, error: 'A Mastra model is checked against a session.' };
      let catalog: SessionModelCatalog;
      try {
        catalog = await sessionCatalog(ctx.sessionId, ctx);
      } catch (error) {
        if (error instanceof MastraModelError) return { ok: false, error: error.message };
        throw error;
      }
      const modelId = request.model.trim();
      if (!catalog.usable.includes(modelId)) return { ok: false, error: unrunnableModelMessage(modelId, catalog) };
      const entry = catalog.models.find(model => model.id === modelId);
      const options: ProviderOptionSelection[] = [...(request.options ?? [])];
      if (request.thinkingLevel && !options.some(option => option.id === EFFORT_OPTION_ID)) {
        options.push({ id: EFFORT_OPTION_ID, value: request.thinkingLevel });
      }
      const effort = options.find(option => option.id === EFFORT_OPTION_ID)?.value;
      const descriptor = entry?.capabilities?.optionDescriptors?.find(candidate => candidate.id === EFFORT_OPTION_ID);
      const levels = descriptor?.type === 'select' ? descriptor.options.map(option => option.id) : [];
      if (effort !== undefined && !levels.includes(String(effort))) {
        return {
          ok: false,
          error: levels.length
            ? `${modelId} has no thinking level ${String(effort)}. Levels: ${levels.join(', ')}.`
            : `${modelId} has no thinking levels to choose from.`,
        };
      }
      const checked = checkOptionSelections({ slug: modelId, capabilities: entry?.capabilities ?? null }, options);
      if (!checked.ok) return checked;
      return {
        ok: true,
        selection: { instanceId: MASTRA_INSTANCE_ID, model: modelId, ...(checked.options.length ? { options: checked.options } : {}) },
      };
    },
    async getSelection(sessionId) {
      try {
        return await liveSelection(sessionId);
      } catch (error) {
        if (error instanceof MastraModelError) return null;
        throw error;
      }
    },
    // A running session switches now; a stopped one keeps the model on its thread for its next run.
    async setSelection(sessionId, selection) {
      try {
        if (!selection) throw new MastraModelError(400, 'A Mastra session always runs a model: pick one.');
        const { controller, threadId, resourceId } = await sessionThread(sessionId);
        if (!threadId) throw new MastraModelError(404, 'Session has no conversation thread yet.');
        const thinkingLevel = getModelSelectionStringOptionValue(selection, EFFORT_OPTION_ID);
        if (thinkingLevel) {
          // Mastra keeps a thinking level on the live session only: a stopped one has nowhere to hold it.
          const live = await controller.getSession(sessionId);
          if (!live || live.thread.getId() !== threadId) {
            throw new MastraModelError(
              400,
              'That session is not running: switch its model without a thinking level, or set it once it runs.',
            );
          }
          await live.model.switch(selection.model, { thinkingLevel: thinkingLevel as never });
          return { ok: true, modelSelection: selection, appliesFrom: 'now' };
        }
        const { live } = await controller.setThreadModel({ resourceId, threadId, modelId: selection.model });
        return { ok: true, modelSelection: selection, appliesFrom: live ? 'now' : 'next-turn' };
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
