/**
 * `factory_list_attachments`: the files attached to the session's card (and to the session itself,
 * for one that works no card), placed in the session's folder under `.factory/attachments/` so the
 * agent reads them with its usual file tools. One build serves both harnesses: a Mastra session
 * has it in-process, a Claude Code session over the Factory MCP endpoint.
 */

import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import type { IntegrationTools } from '@factory/integrations';
import { materializeSessionAttachments } from '@factory/sandbox';
import type { SourceControlSessionLookup } from '@factory/session';
import { attachmentSandboxPath } from '@factory/store';
import type { AttachmentRecord, AttachmentService, WorkItemsStorage } from '@factory/store';

export interface AttachmentToolDependencies {
  attachments: AttachmentService;
  workItems: Pick<WorkItemsStorage, 'listWorkItemIdsForSession'>;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /** Places files in the session's sandbox; the default writes into its memoized sandbox. */
  materialize?: typeof materializeSessionAttachments;
}

interface SessionScope {
  orgId: string;
  sessionId: string;
  factoryProjectId?: string;
}

function sessionScope(requestContext: RequestContext | undefined): SessionScope | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as
    | AgentControllerRequestContext<{ factoryProjectId?: string }>
    | undefined;
  const orgId = getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext));
  if (!controller?.sessionId || !orgId) return undefined;
  const factoryProjectId = controller.getState?.().factoryProjectId;
  return { orgId, sessionId: controller.sessionId, ...(factoryProjectId ? { factoryProjectId } : {}) };
}

/** The card the session works, if any: a session is bound to one card at most. */
async function sessionCardId(scope: SessionScope, deps: AttachmentToolDependencies): Promise<string | undefined> {
  if (!scope.factoryProjectId) return undefined;
  const ids = await deps.workItems.listWorkItemIdsForSession({
    orgId: scope.orgId,
    factoryProjectId: scope.factoryProjectId,
    sessionId: scope.sessionId,
  });
  if (ids.length > 1) throw new Error(`Session ${scope.sessionId} is bound to several cards (${ids.join(', ')}).`);
  return ids[0];
}

export async function createAttachmentTools({
  requestContext,
  deps,
}: {
  requestContext: RequestContext | undefined;
  deps: AttachmentToolDependencies;
}): Promise<IntegrationTools> {
  const scope = sessionScope(requestContext);
  if (!scope) return {};
  const materialize = deps.materialize ?? materializeSessionAttachments;

  return {
    factory_list_attachments: createTool({
      id: 'factory_list_attachments',
      description:
        "List the files attached to this session's card (client materials, screenshots, designs, documents) and place them " +
        'in your working folder under .factory/attachments/, where you read them with your usual tools. Call it when ' +
        'a message names attachments («Вкладення: …») or before work that may need the client’s files. .factory/ is never ' +
        'committed: copy a file into the repository path the task names (and commit it there) when it belongs in the code ' +
        'or docs.',
      inputSchema: z.object({}),
      execute: async () => {
        const workItemId = await sessionCardId(scope, deps);
        await deps.attachments.records.ensureReady();
        const records: Array<AttachmentRecord & { scope: 'card' | 'session' }> = [
          ...(workItemId
            ? (await deps.attachments.records.listForWorkItem({ orgId: scope.orgId, workItemId })).map(record => ({
                ...record,
                scope: 'card' as const,
              }))
            : []),
          ...(await deps.attachments.records.listForSession({ orgId: scope.orgId, sessionId: scope.sessionId })).map(
            record => ({ ...record, scope: 'session' as const }),
          ),
        ];
        const listed = records.map(record => ({
          name: record.name,
          path: attachmentSandboxPath(record),
          mime: record.mime,
          size: record.size,
          source: record.source,
          sourceUrl: record.sourceUrl,
          addedAt: record.addedAt.toISOString(),
          attachedTo: record.scope,
        }));
        if (records.length === 0) return { attachments: [], placed: true };

        // The sandbox memo is keyed by the session's row id, not its public session id.
        const row = await deps.sessions.getBySessionId(scope.sessionId);
        if (!row) {
          return {
            attachments: listed,
            placed: false,
            reason: 'This session has no sandbox, so the files could not be placed; they are listed only.',
          };
        }
        try {
          const result = await materialize({
            sessionId: row.id,
            attachments: records.map(record => ({
              sandboxPath: attachmentSandboxPath(record),
              size: record.size,
              open: async () => {
                const opened = await deps.attachments.open({ orgId: scope.orgId, id: record.id });
                if (!opened) throw new Error(`Attachment ${record.name} was deleted.`);
                return opened.content;
              },
            })),
          });
          return { folder: result.root, attachments: listed, placed: true };
        } catch (error) {
          return {
            attachments: listed,
            placed: false,
            reason: `The files could not be placed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
  };
}
