/**
 * Tools a Product session has besides moving its own card: filing the phases it agreed on as
 * Development (Work) cards under the Product card, and checking a product document before its
 * review phase may let the card on. A Product session is a bound run, which otherwise gets only
 * the governed move, so these are offered to the `product` seat alone.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { boardForWorkItem, workItemSource } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { AuditRecorder, CommentsDomain } from '@factory/feed';
import type { IntegrationTools } from '@factory/integrations';
import {
  changeFolderOf,
  checkProductDocumentStructure,
  PRODUCT_CHANGE_KEY,
  PRODUCT_CHILDREN_KEY,
  PRODUCT_CONTEXT,
  PRODUCT_DOC_CHECKS_KEY,
  PRODUCT_DOCS_SYNC_KEY,
  PRODUCT_DOCUMENT_TYPES,
  productBoard,
  productChildWorkItemIds,
  productDocumentPassed,
  recordedProductDocumentCheck,
  withProductChild,
  withProductDocumentCheck,
  workItemBranch,
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
  /**
   * The absolute folder another card's sessions work in on this machine (the local sandbox's
   * `<root>/work-items/<factory>/<card branch>`), so a Product session can read a sibling change
   * that is not merged yet. Absent when the host's sandbox keeps no shared card folders.
   */
  cardFolderPath?: (input: { factoryProjectId: string; branch: string }) => string | undefined;
  /**
   * A thread's stored messages, oldest first, so a Product session can read a session the person
   * referenced. Absent when the host has no message store: `factory_read_session` then fails loudly.
   */
  readThread?: (input: { threadId: string; resourceId?: string }) => Promise<MastraDBMessage[]>;
}

const DEFAULT_SESSION_MESSAGES = 30;
const MAX_SESSION_MESSAGES = 100;
const MAX_MESSAGE_TEXT = 2_000;

/** A stored message as plain text: its text parts only, tool calls and results left out. */
export function messageText(message: MastraDBMessage): string {
  const content = message.content as { parts?: unknown[]; content?: unknown } | string | undefined;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .flatMap(part =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? [String((part as { text?: unknown }).text ?? '')]
        : [],
    )
    .join('\n')
    .trim();
  if (text) return text;
  return typeof content?.content === 'string' ? content.content.trim() : '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/** The file of each readable document of a change; a brief may have a client-language copy (`requirements.<lang>.md`). */
const CHANGE_DOCUMENT_FILES = {
  research: 'research.md',
  brief: 'requirements.md',
  spec: 'design.md',
  tasks: 'tasks.md',
} as const;
type ChangeDocument = keyof typeof CHANGE_DOCUMENT_FILES;
const CHECK_TYPE_OF: Record<ChangeDocument, (typeof PRODUCT_DOCUMENT_TYPES)[number]> = {
  research: 'enrich',
  brief: 'brief',
  spec: 'spec',
  tasks: 'tasks',
};

/** The branch a card's sessions work on, as its folder is named: its Product session's, else derived from the card. */
function cardBranch(card: Card): string {
  const sessions = card.sessions as Record<string, { branch?: string } | undefined> | null | undefined;
  const recorded = sessions?.[PRODUCT_CONTEXT]?.branch;
  if (recorded) return recorded;
  return workItemBranch({ id: card.id, source: workItemSource(card.externalSource), metadata: card.workItem?.metadata });
}

/** The change folder a card's work is in (`changes/<change>`), from its recorded document checks, or undefined. */
function cardChangeFolder(card: Card): string | undefined {
  for (const type of ['tasks', 'spec', 'brief', 'enrich'] as const) {
    const recorded = recordedProductDocumentCheck(card.metadata, type);
    if (recorded) return changeFolderOf(recorded.path);
  }
  const stamped = card.metadata?.[PRODUCT_CHANGE_KEY];
  return typeof stamped === 'string' ? stamped : undefined;
}

/** Whether `child` resolves inside `parent` (both real paths). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every `<repo>/changes/<change>/<file>` (and `<repo>/docs/changes/…`) in a card folder, archive excluded. */
async function findChangeDocuments(folder: string, file: string): Promise<string[]> {
  const found: string[] = [];
  let repos: string[] = [];
  try {
    repos = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return found;
  }
  for (const repo of repos) {
    for (const base of [join(folder, repo, 'changes'), join(folder, repo, 'docs', 'changes')]) {
      let changes: string[] = [];
      try {
        changes = (await readdir(base, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && entry.name !== 'archive')
          .map(entry => entry.name);
      } catch {
        continue;
      }
      for (const change of changes) {
        const candidate = join(base, change, file);
        try {
          if ((await stat(candidate)).isFile()) found.push(candidate);
        } catch {
          // not in this change
        }
      }
    }
  }
  return found;
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
        "File one agreed phase as a card on the Development (Work) board, under this Product card: the new card's parent is this card, this card lists it, and the card records this change's folder. Filing the same title again under this card returns the existing card instead of a duplicate. Name the repository the phase's code lives in. File the change's docs-sync task last, with `docsSync: true` and the documentation repository: Development merges the change's delta into features/ on it once the other cards are merged.",
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
          docsSync: z
            .boolean()
            .optional()
            .describe(
              "True only for the change's docs-sync task, filed last in the documentation repository: Development runs the docs skill on it to merge the change's delta into features/ and archive the change.",
            ),
        })
        .strict(),
      execute: async ({ title, brief, repository, docsSync }, execution) => {
        const { binding, item: parent } = await currentBinding(execution?.requestContext);
        const project = { orgId: binding.orgId, factoryProjectId: binding.factoryProjectId };
        const existingIds = productChildWorkItemIds(parent.metadata);
        for (const id of existingIds) {
          const child = await options.storage.get({ orgId: binding.orgId, id });
          if (child && child.title.trim().toLowerCase() === title.toLowerCase()) {
            return { id: child.id, title: child.title, stages: child.stages, reused: true };
          }
        }
        // The change folder, from the change's own recorded documents: the docs-sync task needs it, every task links it.
        const recorded =
          recordedProductDocumentCheck(parent.metadata, 'tasks') ?? recordedProductDocumentCheck(parent.metadata, 'spec');
        const change = recorded ? changeFolderOf(recorded.path) : undefined;
        if (docsSync === true && change === undefined) {
          throw new Error(
            "The docs-sync task needs the change folder: run factory_check_product_document on this change's tasks.md first.",
          );
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
            input: {
              title,
              board: 'work',
              parentWorkItemId: parent.id,
              metadata: {
                repository,
                ...(change !== undefined ? { [PRODUCT_CHANGE_KEY]: change } : {}),
                ...(docsSync === true ? { [PRODUCT_DOCS_SYNC_KEY]: true } : {}),
              },
            },
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

    factory_comment_product_task: createTool({
      id: 'factory_comment_product_task',
      description:
        "Post a comment on a Development card this Product card filed (one of its phase tasks), e.g. when the agreed plan changed after it was filed: what changed in its task, which spec sections, and whether it should wait. Only this card's own children can be commented on; the comment is the agent's, under this session.",
      inputSchema: z
        .object({
          workItem: z.string().trim().min(1).describe("The Development card's id, as factory_create_work_item returned it."),
          body: z.string().trim().min(1).max(8000).describe("The comment, in the person's language."),
        })
        .strict(),
      execute: async ({ workItem, body }, execution) => {
        const { binding, item: parent } = await currentBinding(execution?.requestContext);
        if (!productChildWorkItemIds(parent.metadata).includes(workItem)) {
          throw new Error('That card was not filed by this Product card: only its own phase tasks can be commented on.');
        }
        const child = await options.storage.get({ orgId: binding.orgId, id: workItem });
        if (!child || child.parentWorkItemId !== parent.id) {
          throw new Error('That card is no longer a task of this Product card.');
        }
        const comment = await options.product.feed.createComment({
          orgId: binding.orgId,
          workItemId: child.id,
          author: actorFromAgentBinding(binding.id),
          body,
        });
        if (comment.status !== 'created') {
          throw new Error(`The comment was not posted (${comment.status === 'invalid' ? comment.message : comment.status}).`);
        }
        return { workItem: child.id, title: child.title, posted: true };
      },
    }),

    factory_list_product_changes: createTool({
      id: 'factory_list_product_changes',
      description:
        "List the OTHER cards on the Product board of this Factory — changes in flight or done — so you find the ones related to this change before asking anything they already settled or estimating work they already cover. For each: id, title, stage, change folder, docs repository and branch, the draft change request if one was opened, which documents it has and whether their checks passed, and the Development cards filed under it (title, stage). Read a related one's documents with factory_read_product_change.",
      inputSchema: z.object({}).strict(),
      execute: async (_input, execution) => {
        const { binding, item: self } = await currentBinding(execution?.requestContext);
        const cards = await options.storage.list({ orgId: binding.orgId, factoryProjectId: binding.factoryProjectId });
        const others = cards.filter(card => card.id !== self.id && boardForWorkItem(card) === productBoard.id);
        const changes = await Promise.all(
          others.map(async card => {
            const documents = PRODUCT_DOCUMENT_TYPES.flatMap(type => {
              const check = recordedProductDocumentCheck(card.metadata, type);
              return check ? [{ type, path: check.path, passed: check.passed, checkedAt: check.checkedAt }] : [];
            });
            const children = (
              await Promise.all(
                productChildWorkItemIds(card.metadata).map(id => options.storage.get({ orgId: binding.orgId, id })),
              )
            ).flatMap(child => (child ? [{ id: child.id, title: child.title, stage: child.stages[0] ?? null }] : []));
            const sessions = card.sessions as Record<string, { sessionId?: string } | undefined> | null | undefined;
            const sessionId = sessions?.[PRODUCT_CONTEXT]?.sessionId;
            let changeRequestUrl: string | null = null;
            if (sessionId) {
              const sourceControl = await options.product.sessions.getSourceControlBySessionId(sessionId);
              const rows = sourceControl ? await sourceControl.sessionRepositories.listBySession({ sessionId }) : [];
              changeRequestUrl = rows.find(row => row.changeRequestUrl)?.changeRequestUrl ?? null;
            }
            const repository = card.metadata?.repository;
            return {
              id: card.id,
              title: card.title,
              stage: card.stages[0] ?? null,
              change: cardChangeFolder(card) ?? null,
              docsRepository: typeof repository === 'string' ? repository : null,
              branch: cardBranch(card),
              changeRequestUrl,
              documents,
              developmentCards: children,
            };
          }),
        );
        return { count: changes.length, changes };
      },
    }),

    factory_read_product_change: createTool({
      id: 'factory_read_product_change',
      description:
        "Read one document of ANOTHER Product card's change, read-only: research (research.md), brief (requirements.md, or its client-language copy with `lang`, e.g. requirements.en.md), spec (design.md) or tasks (tasks.md). It reads that card's working copy on this machine (its unmerged branch). When the card has no working copy here, it fails and names the exact source_control_api_read call that reads the same file from the docs repository at the card's branch.",
      inputSchema: z
        .object({
          card: z.string().trim().min(1).describe('The other card id, as factory_list_product_changes listed it.'),
          document: z.enum(['research', 'brief', 'spec', 'tasks']),
          lang: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/, 'A language code such as "en".')
            .optional()
            .describe("Only for the brief's client-language copy, e.g. 'en' for requirements.en.md."),
        })
        .strict(),
      execute: async ({ card: cardId, document, lang }, execution) => {
        const { binding, item: self } = await currentBinding(execution?.requestContext);
        if (cardId === self.id) throw new Error("That is this session's own card: read its documents from your workspace.");
        const card = await options.storage.get({ orgId: binding.orgId, id: cardId });
        if (!card || card.factoryProjectId !== binding.factoryProjectId) {
          throw new Error('No such card in this Factory: only cards of the same Factory can be read.');
        }
        if (boardForWorkItem(card) !== productBoard.id) throw new Error('That card is not on the Product board.');
        if (lang && document !== 'brief') throw new Error('`lang` applies to the brief only.');
        const file = lang ? `requirements.${lang}.md` : CHANGE_DOCUMENT_FILES[document];
        const branch = cardBranch(card);
        const change = cardChangeFolder(card);
        const repository = typeof card.metadata?.repository === 'string' ? card.metadata.repository : undefined;
        const viaBranch =
          change && repository
            ? `Read it from the docs repository instead: source_control_api_read with path "repos/${repository}/contents/<docs root>/${change}/${file}" and query { "ref": "${branch}" } (GitHub; on GitLab "projects/<project>/repository/files/<url-encoded path>/raw" with ref=${branch}).`
            : 'That card has recorded no checked document yet, so its change folder is unknown; ask the person, or read its draft change request.';
        const folder = options.product.cardFolderPath?.({ factoryProjectId: card.factoryProjectId, branch });
        if (!folder) {
          throw new Error(`This host keeps no shared card folders, so that card's working copy cannot be read here. ${viaBranch}`);
        }
        let root: string;
        try {
          root = await realpath(folder);
        } catch {
          throw new Error(
            `"${card.title}" has no working copy on this machine (it has not run here, or it was cleaned up). ${viaBranch}`,
          );
        }
        // The path its own check recorded first; else the file found in its change folder.
        const candidates: string[] = [];
        const recorded = lang ? undefined : recordedProductDocumentCheck(card.metadata, CHECK_TYPE_OF[document]);
        if (recorded) candidates.push(isAbsolute(recorded.path) ? recorded.path : join(root, recorded.path));
        const found = await findChangeDocuments(root, file);
        const inChange = change ? found.filter(path => path.split(sep).join('/').includes(`/${change}/`)) : [];
        candidates.push(...(inChange.length > 0 ? inChange : found));
        for (const candidate of candidates) {
          let real: string;
          try {
            real = await realpath(candidate);
          } catch {
            continue;
          }
          // Never outside that card's folder (a recorded absolute path elsewhere, a symlink).
          if (!within(root, real)) continue;
          const content = await readFile(real, 'utf8');
          if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
            throw new Error(`${file} of "${card.title}" is larger than ${MAX_DOCUMENT_BYTES} bytes.`);
          }
          return {
            card: card.id,
            title: card.title,
            stage: card.stages[0] ?? null,
            change: change ?? null,
            document,
            path: relative(root, real).split(sep).join('/'),
            source: 'working copy (unmerged branch)',
            branch,
            content,
          };
        }
        throw new Error(`"${card.title}" has no ${file} in its working copy yet. ${viaBranch}`);
      },
    }),

    factory_read_session: createTool({
      id: 'factory_read_session',
      description:
        "Read, read-only, a session or card of this Factory that the person referenced (a `factory-refs` block in their message, or one they name): the card it belongs to (title, board, stage; for a Product card its change folder and checked documents) and the last messages of its conversation as plain text (tool calls left out). Give `session` (a session id) or `card` (a card id), and `thread` when the reference names one. Only sessions of this Factory that the person may open: another person's private session is refused. Read referenced context with this first instead of searching for it.",
      inputSchema: z
        .object({
          session: z.string().trim().min(1).optional().describe('The referenced session id.'),
          card: z.string().trim().min(1).optional().describe('The referenced card (work item) id.'),
          thread: z.string().trim().min(1).optional().describe('The thread id, when the reference names one.'),
          messages: z
            .number()
            .int()
            .min(1)
            .max(MAX_SESSION_MESSAGES)
            .optional()
            .describe(`How many of the latest messages to return (default ${DEFAULT_SESSION_MESSAGES}).`),
        })
        .strict()
        .refine(input => Boolean(input.session ?? input.card), { message: 'Give `session` or `card`.' }),
      execute: async ({ session: sessionInput, card: cardInput, thread, messages }, execution) => {
        const { binding } = await currentBinding(execution?.requestContext);
        const lookup = options.product.sessions;
        const caller = await lookup.getBySessionId(binding.sessionId);

        // The card: named directly, or the one the referenced session is bound to.
        let card: Card | null = null;
        if (cardInput) {
          card = await options.storage.get({ orgId: binding.orgId, id: cardInput });
          if (!card || card.factoryProjectId !== binding.factoryProjectId) {
            throw new Error('No such card in this Factory: only cards of the same Factory can be read.');
          }
        }

        let sessionId = sessionInput;
        let runBinding: FactoryRunBindingRecord | null = null;
        if (!sessionId && card) {
          const entries = Object.values((card.sessions ?? {}) as Record<string, { sessionId?: string } | undefined>);
          sessionId = entries.find(entry => entry?.sessionId)?.sessionId;
        }
        if (sessionId) {
          const target = await lookup.getBySessionId(sessionId);
          if (!target || target.orgId !== binding.orgId || target.factoryProjectId !== binding.factoryProjectId) {
            throw new Error('No such session in this Factory: only sessions of the same Factory can be read.');
          }
          if (target.visibility === 'private' && (!caller || target.userId !== caller.userId)) {
            throw new Error("That is another person's private session: it cannot be read from here.");
          }
          runBinding = await options.storage.findActiveRunBindingForSession({
            orgId: binding.orgId,
            factoryProjectId: binding.factoryProjectId,
            sessionId,
          });
          if (!card && runBinding) card = await options.storage.get({ orgId: binding.orgId, id: runBinding.workItemId });
        }

        const cardSummary = card
          ? {
              id: card.id,
              title: card.title,
              board: boardForWorkItem(card),
              stage: card.stages[0] ?? null,
              ...(boardForWorkItem(card) === productBoard.id
                ? {
                    change: cardChangeFolder(card) ?? null,
                    documents: PRODUCT_DOCUMENT_TYPES.flatMap(type => {
                      const check = recordedProductDocumentCheck(card!.metadata, type);
                      return check ? [{ type, path: check.path, passed: check.passed }] : [];
                    }),
                    readDocumentsWith: 'factory_read_product_change',
                  }
                : {}),
            }
          : null;

        if (!sessionId) return { card: cardSummary, session: null, messages: [] };
        const readThread = options.product.readThread;
        if (!readThread) throw new Error("This host keeps no message store, so a session's conversation cannot be read here.");
        const threadId = thread ?? runBinding?.threadId ?? sessionId;
        const stored = await readThread({ threadId, ...(runBinding ? { resourceId: runBinding.resourceId } : {}) });
        const conversation = stored
          .filter(message => message.role === 'user' || message.role === 'assistant')
          .map(message => ({
            role: message.role,
            at: new Date(message.createdAt).toISOString(),
            text: clip(messageText(message), MAX_MESSAGE_TEXT),
          }))
          .filter(message => message.text.length > 0);
        const latest = conversation.slice(-(messages ?? DEFAULT_SESSION_MESSAGES));
        return {
          card: cardSummary,
          session: sessionId,
          thread: threadId,
          totalMessages: conversation.length,
          messages: latest,
        };
      },
    }),

    factory_check_product_document: createTool({
      id: 'factory_check_product_document',
      description:
        "Check a product document in the workspace and record the result on this Product card. Types and their files in <docs>/changes/<change>/: enrich = research.md, brief = requirements.md (client-facing), spec = design.md (technical), tasks = tasks.md (phases). It verifies the type's required sections; for the spec, its Mermaid C4, sequence and data-flow diagrams; for tasks, that every task has role, depends-on, acceptance and verify and depends only on tasks that exist. List every contradiction you found between this document and the project's existing documents and decision records; the check passes only when every one is resolved. Sending the brief to Approval needs a passing brief check, moving the card from Spec review to Phases a passing spec check, and handing the phases to Phases review a passing tasks check. A default section the person asked to leave out (e.g. the brief's \"Done means\") goes in `waived` with their reason; core sections (the brief's Goal, Use cases, Out of scope, Phases, Estimate) cannot be waived. Waive only what the person asked to drop, never on your own.",
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
          waived: z
            .array(
              z
                .object({
                  section: z.string().trim().min(1).max(200).describe('The section label as the check reports it, e.g. "Done means".'),
                  reason: z.string().trim().min(1).max(1000).describe("The person's reason for dropping it, in their words."),
                })
                .strict(),
            )
            .max(30)
            .optional()
            .describe('Default sections the person asked to leave out of this document. Only what the person asked for.'),
        })
        .strict(),
      execute: async ({ type, path, contradictions, waived }, execution) => {
        const { binding } = await currentBinding(execution?.requestContext);
        const markdown = await readDocument(execution?.workspace, path);
        const structure = checkProductDocumentStructure(type, markdown, waived ?? []);
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
