/**
 * `factory_list_attachments`: the files attached to the session's card (and to the session itself,
 * for one that works no card), placed in the session's folder under `.factory/attachments/` so the
 * agent reads them with its usual file tools.
 *
 * `factory_attach_file`: the other way — a file the agent made in its folder (a build such as an
 * `.apk`, a report, a recording) becomes the card's attachment, which people download from the
 * card's «Файли» and which outlives the sandbox. The bytes are read as the agent (`openSessionFile`).
 *
 * One build serves both harnesses: a Mastra session has them in-process, a Claude Code session over
 * the Factory MCP endpoint.
 */

import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import type { IntegrationTools } from '@factory/integrations';
import { materializeSessionAttachments, openSessionFile, SessionFileError } from '@factory/sandbox';
import type { SourceControlSessionLookup } from '@factory/session';
import { attachmentSandboxPath } from '@factory/store';
import type { AttachmentRecord, AttachmentService, WorkItemsStorage } from '@factory/store';

export interface AttachmentToolDependencies {
  attachments: AttachmentService;
  workItems: Pick<WorkItemsStorage, 'listWorkItemIdsForSession'>;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  /** Places files in the session's sandbox; the default writes into its memoized sandbox. */
  materialize?: typeof materializeSessionAttachments;
  /** Reads a file from the session's sandbox as the agent; the default reads its memoized sandbox. */
  openFile?: typeof openSessionFile;
}

interface SessionScope {
  orgId: string;
  sessionId: string;
  userId?: string;
  factoryProjectId?: string;
}

function sessionScope(requestContext: RequestContext | undefined): SessionScope | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as
    | AgentControllerRequestContext<{ factoryProjectId?: string }>
    | undefined;
  const user = getFactoryAuthUserFromContext(requestContext);
  const orgId = getFactoryAuthOrgId(user);
  if (!controller?.sessionId || !orgId) return undefined;
  const factoryProjectId = controller.getState?.().factoryProjectId;
  return {
    orgId,
    sessionId: controller.sessionId,
    ...(user?.id ? { userId: user.id } : {}),
    ...(factoryProjectId ? { factoryProjectId } : {}),
  };
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
  const openFile = deps.openFile ?? openSessionFile;

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
    factory_attach_file: createTool({
      id: 'factory_attach_file',
      description:
        "Attach a file from your working folder to this session's card, where people download it from the card's " +
        '«Файли» (Files) — it stays there after the sandbox is removed. Use it for what the person asked to receive ' +
        'and that does not belong in the repository: a build (an .apk, .aab, .ipa, a zip), a report, a recording, a ' +
        'screenshot set. Give the path relative to your working folder (or absolute inside it). Files above the ' +
        "Factory's attachment limit are refused; say so instead of splitting them. Tell the person the file is in «Файли».",
      inputSchema: z.object({
        path: z.string().min(1).describe('The file, relative to your working folder or absolute inside it.'),
        name: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('The name people see, e.g. "book-fate-1.4.0-release.apk". Defaults to the file name.'),
      }),
      execute: async ({ path, name }) => {
        const workItemId = await sessionCardId(scope, deps);
        const row = await deps.sessions.getBySessionId(scope.sessionId);
        if (!row) return { attached: false, reason: 'This session has no sandbox, so there is no file to attach.' };
        let file: Awaited<ReturnType<typeof openSessionFile>>;
        try {
          // The sandbox memo is keyed by the session's row id, not its public session id.
          file = await openFile({ sessionId: row.id, path, maxBytes: deps.attachments.maxBytes });
        } catch (error) {
          if (error instanceof SessionFileError) {
            return { attached: false, reason: error.message, ...(error.reason === 'too_large' ? { maxBytes: deps.attachments.maxBytes } : {}) };
          }
          throw error;
        }
        const record = await deps.attachments.ingest({
          orgId: scope.orgId,
          owner: workItemId
            ? { workItemId, factoryProjectId: scope.factoryProjectId! }
            : { sessionId: scope.sessionId, factoryProjectId: scope.factoryProjectId ?? null },
          name: name ?? file.name,
          body: file.content,
          source: 'agent',
          sourceUrl: null,
          addedBy: scope.userId ?? 'agent',
        });
        return {
          attached: true,
          attachedTo: workItemId ? 'card' : 'session',
          id: record.id,
          name: record.name,
          mime: record.mime,
          size: record.size,
          from: file.relativePath,
        };
      },
    }),
  };
}
