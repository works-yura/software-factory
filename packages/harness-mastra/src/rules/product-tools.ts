/**
 * Tools a Product session has besides moving its own card: filing the phases it agreed on as
 * Development (Work) cards under the Product card, and checking a product document before its
 * review phase may let the card on. A Product session is a bound run, which otherwise gets only
 * the governed move, so these are offered to the `product` seat alone.
 */

import { createHash } from 'node:crypto';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { boardForWorkItem } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { AuditRecorder, CommentsDomain } from '@factory/feed';
import type { IntegrationTools } from '@factory/integrations';
import {
  checkProductDocumentStructure,
  PRODUCT_CHILDREN_KEY,
  PRODUCT_CONTEXT,
  PRODUCT_DOC_CHECKS_KEY,
  PRODUCT_DOCUMENT_TYPES,
  productBoard,
  productChildWorkItemIds,
  productDocumentPassed,
  withProductChild,
  withProductDocumentCheck,
} from '@factory/pipelines';
import type { ProductDocumentCheck } from '@factory/pipelines';
import type { FactoryTransitionService } from '@factory/runtime';
import type { FactorySessionSourceLookup, SourceControlSessionLookup } from '@factory/session';
import { resolveFactorySessionAddress } from '@factory/session';
import { actorFromAgentBinding, WorkItemRelationError, WorkItemUpdateConflictError } from '@factory/store';
import type { Card, FactoryRunBindingRecord, WorkItemsStorage } from '@factory/store';
import { createFactoryWorkItem } from '@factory/work-items';

import { requireLinkedRepository } from '../tools/work-item-tools.ts';

/** What a Product session needs beyond the bound-run tools' own dependencies. */
export interface ProductToolDependencies {
  /** Posts each filed card's brief as its first comment. */
  feed: Pick<CommentsDomain, 'createComment'>;
  auditRecorder: AuditRecorder;
  /** The session row (whose owner files the cards) and its provider (whose repositories a card can name). */
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId' | 'getSourceControlBySessionId'>;
}

interface ProductToolOptions {
  storage: WorkItemsStorage;
  transitionService: Pick<FactoryTransitionService, 'transition'>;
  sessions?: FactorySessionSourceLookup;
  boards?: BoardRegistry;
  product: ProductToolDependencies;
}

const UPDATE_ATTEMPTS = 3;
const MAX_DOCUMENT_BYTES = 1_000_000;

const repositorySchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/[^/\s]+$/, 'Use the owner/name form, e.g. "acme/server".');

/** Whether a run bound with `binding` is a Product session: the `product` seat of a Product card. */
export function isProductBinding(binding: Pick<FactoryRunBindingRecord, 'role'>, item: Card | null): boolean {
  return binding.role === PRODUCT_CONTEXT && item !== null && boardForWorkItem(item) === productBoard.id;
}

/**
 * Writes `change(metadata)` onto the card, re-reading it when a concurrent write moved its
 * revision, so a check or a filed child is never lost to a race.
 */
async function updateMetadata(
  storage: WorkItemsStorage,
  binding: FactoryRunBindingRecord,
  key: string,
  change: (metadata: Record<string, unknown> | null) => Record<string, unknown>,
): Promise<Card> {
  for (let attempt = 1; ; attempt++) {
    const item = await storage.get({ orgId: binding.orgId, id: binding.workItemId });
    if (!item) throw new Error('The Product card this session is bound to no longer exists.');
    try {
      const updated = await storage.update({
        orgId: binding.orgId,
        id: item.id,
        userId: `agent:${binding.id}`,
        expectedRevision: item.revision,
        patch: { metadata: { [key]: change(item.metadata)[key] } },
      });
      if (!updated) throw new Error('The Product card this session is bound to no longer exists.');
      return updated.item;
    } catch (error) {
      if (!(error instanceof WorkItemUpdateConflictError) || attempt >= UPDATE_ATTEMPTS) throw error;
    }
  }
}

/** Reads a document from the session's sandbox, failing loudly when there is none or it can't be read. */
async function readDocument(workspace: unknown, path: string): Promise<string> {
  const sandbox = (workspace as { sandbox?: { executeCommand?: unknown } } | undefined)?.sandbox as
    | { executeCommand?: (command: string, args?: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> }
    | undefined;
  if (typeof sandbox?.executeCommand !== 'function') {
    throw new Error('This session has no workspace sandbox to read the document from.');
  }
  const result = await sandbox.executeCommand('cat', ['--', path]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not read ${path}: ${result.stderr.trim() || `cat exited with ${result.exitCode}`}`);
  }
  if (Buffer.byteLength(result.stdout) > MAX_DOCUMENT_BYTES) {
    throw new Error(`${path} is larger than ${MAX_DOCUMENT_BYTES} bytes; split it before checking.`);
  }
  return result.stdout;
}

/** The Product session's tools, for the card it is bound to. */
export function createProductTools(
  options: ProductToolOptions & { requestContext: RequestContext },
  boundWorkItemId: string,
): IntegrationTools {
  /** The live binding of the calling turn, which must still be this session's Product seat on its card. */
  const currentBinding = async (requestContext: RequestContext | undefined) => {
    const resolution = await resolveFactorySessionAddress({
      requestContext: requestContext ?? options.requestContext,
      storage: options.storage,
      sessions: options.sessions,
    });
    const binding = resolution ? await options.storage.findActiveRunBinding(resolution.address) : null;
    if (!binding || binding.workItemId !== boundWorkItemId || binding.role !== PRODUCT_CONTEXT) {
      throw new Error('This session is no longer the Product session of its card.');
    }
    const item = await options.storage.get({ orgId: binding.orgId, id: binding.workItemId });
    if (!isProductBinding(binding, item)) throw new Error('This session is not bound to a Product card.');
    return { binding, item: item! };
  };

  return {
    factory_create_work_item: createTool({
      id: 'factory_create_work_item',
      description:
        "File one agreed phase as a card on the Development (Work) board, under this Product card: the new card's parent is this card, and this card lists it. Filing the same title again under this card returns the existing card instead of a duplicate. Name the repository the phase's code lives in.",
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(512).describe('Short title, as it should read on the card.'),
          brief: z
            .string()
            .trim()
            .min(1)
            .max(8000)
            .describe(
              'What the phase delivers, its acceptance criteria, dependencies, and links to the exact spec sections it implements; posted as the first comment.',
            ),
          repository: repositorySchema.describe('The repository linked to this Factory the phase changes, as owner/name.'),
        })
        .strict(),
      execute: async ({ title, brief, repository }, execution) => {
        const { binding, item: parent } = await currentBinding(execution?.requestContext);
        const project = { orgId: binding.orgId, factoryProjectId: binding.factoryProjectId };
        const existingIds = productChildWorkItemIds(parent.metadata);
        for (const id of existingIds) {
          const child = await options.storage.get({ orgId: binding.orgId, id });
          if (child && child.title.trim().toLowerCase() === title.toLowerCase()) {
            return { id: child.id, title: child.title, stages: child.stages, reused: true };
          }
        }
        await requireLinkedRepository({
          sessions: options.product.sessions,
          sessionId: binding.sessionId,
          ...project,
          slug: repository,
        });
        const session = await options.product.sessions.getBySessionId(binding.sessionId);
        if (!session) throw new Error('This session has no session row to file cards as.');
        const boards = options.boards;
        if (!boards) throw new Error('Factory boards are not available right now.');
        let created: Awaited<ReturnType<typeof createFactoryWorkItem>>;
        try {
          created = await createFactoryWorkItem({
            workItems: options.storage,
            boards,
            transitionService: options.transitionService,
            audit: async input => {
              await options.product.auditRecorder.record({
                orgId: binding.orgId,
                actorId: `agent:${binding.id}`,
                actorType: 'agent',
                ...input,
              });
            },
            ...project,
            userId: session.userId,
            // Phases are Development work: the card goes to Work's first phase, not where intake routes send new cards.
            input: { title, board: 'work', parentWorkItemId: parent.id, metadata: { repository } },
          });
        } catch (error) {
          if (error instanceof WorkItemRelationError) throw new Error(`The parent was refused: ${error.message}`);
          throw error;
        }
        if (created.status === 'refused') throw new Error(created.message);
        if (created.status === 'rejected') throw new Error(`The board refused the new card: ${created.reason}`);
        const child = created.item;
        const warnings: string[] = [];
        await updateMetadata(options.storage, binding, PRODUCT_CHILDREN_KEY, metadata =>
          withProductChild(metadata, child.id),
        );
        try {
          const comment = await options.product.feed.createComment({
            orgId: binding.orgId,
            workItemId: child.id,
            author: actorFromAgentBinding(binding.id),
            body: brief,
          });
          if (comment.status !== 'created') {
            warnings.push(`The brief was not posted (${comment.status === 'invalid' ? comment.message : comment.status}).`);
          }
        } catch (error) {
          warnings.push(`The brief was not posted: ${error instanceof Error ? error.message : String(error)}`);
        }
        const result = { id: child.id, title: child.title, stages: child.stages, parentWorkItemId: parent.id };
        return warnings.length > 0 ? { ...result, warnings } : result;
      },
    }),

    factory_check_product_document: createTool({
      id: 'factory_check_product_document',
      description:
        "Check a product document in the workspace and record the result on this Product card. Types and their files in <docs>/changes/<change>/: enrich = research.md, brief = requirements.md (client-facing), spec = design.md (technical), tasks = tasks.md (phases). It verifies the type's required sections; for the spec, its Mermaid C4, sequence and data-flow diagrams; for tasks, that every task has role, depends-on, acceptance and verify and depends only on tasks that exist. List every contradiction you found between this document and the project's existing documents and decision records; the check passes only when every one is resolved. Sending the brief to Approval needs a passing brief check, moving the card from Spec review to Phases a passing spec check, and handing the phases to Phases review a passing tasks check.",
      inputSchema: z
        .object({
          type: z.enum(PRODUCT_DOCUMENT_TYPES).describe('Which document this is.'),
          path: z.string().trim().min(1).max(1000).describe('Path of the document in the workspace.'),
          contradictions: z
            .array(
              z.object({
                finding: z.string().trim().min(1).max(2000).describe('What contradicts what, naming both documents.'),
                resolved: z.boolean(),
                resolution: z.string().trim().min(1).max(2000).optional(),
              }),
            )
            .max(100)
            .describe('Contradictions with existing documents and decision records; empty when you found none.'),
        })
        .strict(),
      execute: async ({ type, path, contradictions }, execution) => {
        const { binding } = await currentBinding(execution?.requestContext);
        const markdown = await readDocument(execution?.workspace, path);
        const structure = checkProductDocumentStructure(type, markdown);
        const check: ProductDocumentCheck = {
          type,
          path,
          sha256: createHash('sha256').update(markdown).digest('hex'),
          passed: productDocumentPassed({ ...structure, contradictions }),
          ...structure,
          contradictions,
          checkedAt: new Date().toISOString(),
        };
        await updateMetadata(options.storage, binding, PRODUCT_DOC_CHECKS_KEY, metadata =>
          withProductDocumentCheck(metadata, check),
        );
        return check;
      },
    }),
  };
}
