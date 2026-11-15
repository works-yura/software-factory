/**
 * The agent's tools (ADR-0051 phase 3), Mastra tools built for one turn and bound to its owner and
 * request: the owner never comes from the model, so another person's requests, notes, channels or
 * Factory grant are out of reach whatever the model asks for.
 *
 * - The person's own data: search and read requests, list notes, write a note (the only write).
 * - Sources: the channels the person turned on, and recent messages of one, read now with the
 *   person's own connection.
 * - Factory, through its MCP as the person: Factories, cards (find, inspect, what needs a person),
 *   a side session's status. Asking a Factory and handing a request over change something outside,
 *   so the tools only *propose* them: the thread shows Confirm / Cancel, and only the person's
 *   Confirm runs them.
 * - Skills: the instructions of a skill the person picked.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { AssistantError } from './errors.ts';
import type { FactoryReadTool, SkillSummary } from './ports.ts';
import type { AssistantService } from './service.ts';
import type { AssistantOwner, AssistantRequest } from './types.ts';
import { REQUEST_STATUSES } from './types.ts';

/** What the tools reach: the service, as the owner. */
export type AssistantToolHost = Pick<
  AssistantService,
  | 'searchRequests'
  | 'readThread'
  | 'listNotes'
  | 'createAgentNote'
  | 'listEnabledChannels'
  | 'readSourceChannel'
  | 'factoriesFor'
  | 'factoryRead'
  | 'factorySessionStatus'
  | 'proposeAction'
  | 'readSkill'
>;

export interface AssistantToolContext {
  owner: AssistantOwner;
  /** The request this turn answers: proposals and «about this request» notes go to it. */
  requestId: string;
  /** The skills the person picked (only these can be read). */
  skills: SkillSummary[];
}

const TEXT_LIMIT = 1500;

function clip(text: string, limit = TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A tool's failure as its answer, so the model can tell the person; anything else is a bug and throws. */
async function guarded<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AssistantError) return { error: error.message };
    throw error;
  }
}

function requestSummary(request: AssistantRequest) {
  return {
    id: request.id,
    topic: request.topic,
    from: request.fromName,
    source: request.source,
    status: request.status,
    factory: request.factory ? { id: request.factory.factoryId, name: request.factory.factoryName, sessionId: request.factory.sessionId ?? null, workItemId: request.factory.workItemId ?? null } : null,
    pendingAction: request.pendingAction ? { kind: request.pendingAction.kind, factory: request.pendingAction.factoryName } : null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

const factoryId = z.string().trim().min(1).max(128).describe('The Factory id, as factory_list_factories lists it.');

export function createAssistantTools(host: AssistantToolHost, context: AssistantToolContext) {
  const { owner, requestId } = context;
  // One proposal per turn: the person confirms one thing at a time.
  let proposed = false;
  const propose = async (input: Parameters<AssistantToolHost['proposeAction']>[2]) => {
    if (proposed) return { error: 'You already proposed an action in this answer; the person decides on it first.' };
    const result = await guarded(() => host.proposeAction(owner, requestId, input));
    if (!('error' in result)) proposed = true;
    return 'error' in result
      ? result
      : {
          proposed: true,
          actionId: result.id,
          note: 'Nothing ran yet. The person sees Confirm / Cancel in the thread; tell them what you propose and why.',
        };
  };
  const read = (tool: FactoryReadTool, id: string, args: Record<string, unknown>) =>
    guarded(() => host.factoryRead(owner, { factoryId: id, tool, args }));

  const tools = {
    assistant_search_requests: createTool({
      id: 'assistant_search_requests',
      description:
        "Search the person's own requests (this assistant's inbox) by text in the topic or sender, and/or by status. Newest activity first.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional().describe('Text in the topic or the sender’s name.'),
        status: z.enum(REQUEST_STATUSES).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async input =>
        guarded(async () => ({
          requests: (await host.searchRequests(owner, input)).map(requestSummary),
        })),
    }),

    assistant_read_request: createTool({
      id: 'assistant_read_request',
      description: "Read one of the person's requests: its topic line and the latest entries of its thread.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(64),
        lastMessages: z.number().int().min(1).max(30).optional(),
      }),
      execute: async input =>
        guarded(async () => {
          const view = await host.readThread(owner, input.requestId, { lastMessages: input.lastMessages ?? 15 });
          return {
            request: requestSummary(view.request),
            messages: view.messages.map(message => ({
              author: message.author,
              from: message.fromName,
              text: clip(message.text),
              at: message.createdAt.toISOString(),
            })),
            files: view.files.map(file => ({ name: file.name, mime: file.mime })),
          };
        }),
    }),

    assistant_list_notes: createTool({
      id: 'assistant_list_notes',
      description: "The person's notes (theirs and the ones you kept for them), newest first, optionally filtered by text.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async input =>
        guarded(async () => {
          const text = input.query?.toLowerCase();
          const notes = (await host.listNotes(owner))
            .filter(note => !text || note.text.toLowerCase().includes(text))
            .slice(0, input.limit ?? 15);
          return {
            notes: notes.map(note => ({
              id: note.id,
              requestId: note.requestId,
              author: note.author,
              text: clip(note.text),
              updatedAt: note.updatedAt.toISOString(),
            })),
          };
        }),
    }),

    assistant_create_note: createTool({
      id: 'assistant_create_note',
      description:
        'Keep a note for the person (a fact to remember, a follow-up, a decision). It shows in their Notes tab marked as yours.',
      inputSchema: z.object({
        text: z.string().trim().min(1).max(4000),
        aboutThisRequest: z.boolean().optional().describe('true: the note is about the request you are answering.'),
      }),
      execute: async input =>
        guarded(async () => {
          const note = await host.createAgentNote(owner, {
            text: input.text,
            requestId: input.aboutThisRequest ? requestId : null,
          });
          return { noteId: note.id };
        }),
    }),

    source_list_channels: createTool({
      id: 'source_list_channels',
      description:
        "The chats the person turned on in their own sources (ClickUp channels and DMs), with each one's mode. Only these can be read.",
      inputSchema: z.object({}),
      execute: async () => guarded(async () => ({ channels: await host.listEnabledChannels(owner) })),
    }),

    source_read_channel: createTool({
      id: 'source_read_channel',
      description:
        "Read the latest messages of one chat the person turned on (or of one thread in it), now, with the person's own connection. Use for context; never answer there.",
      inputSchema: z.object({
        channel: z.string().trim().min(1).max(300).describe('The channel ref from source_list_channels.'),
        threadId: z.string().trim().min(1).max(128).optional().describe('A thread root message id: read its replies instead.'),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async input =>
        guarded(async () => {
          const read = await host.readSourceChannel(owner, {
            ref: input.channel,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            limit: input.limit ?? 20,
          });
          return { ...read, messages: read.messages.map(message => ({ ...message, text: clip(message.text) })) };
        }),
    }),

    factory_list_factories: createTool({
      id: 'factory_list_factories',
      description:
        "The organization's Factories (software agents with boards of cards) the person can reach, as the person. Empty with connected=false when the person has not allowed the assistant to reach Factory.",
      inputSchema: z.object({}),
      execute: async () => guarded(() => host.factoriesFor(owner)),
    }),

    factory_find_work_items: createTool({
      id: 'factory_find_work_items',
      description:
        "Find cards in one Factory (as the person): by text or #number, stage, whether an agent works on it now, or cards the person filed. Read-only.",
      inputSchema: z.object({
        factoryId,
        query: z.string().trim().min(1).max(200).optional(),
        stage: z.string().trim().min(1).max(64).optional(),
        active: z.boolean().optional(),
        requestedByMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ factoryId: id, requestedByMe, ...rest }) =>
        read('factory_list_work_items', id, {
          ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
          ...(requestedByMe ? { requestedBy: 'me' } : {}),
          limit: rest.limit ?? 10,
        }),
    }),

    factory_inspect_work_item: createTool({
      id: 'factory_inspect_work_item',
      description:
        "Everything one Factory knows about a card (as the person): description, stage history, its sessions and whether they run, recent comments. Read-only.",
      inputSchema: z.object({ factoryId, workItem: z.string().trim().min(1).max(64).describe('Card id, or its number like "#123".') }),
      execute: async ({ factoryId: id, workItem }) => read('factory_inspect_work_item', id, { workItem }),
    }),

    factory_list_attention: createTool({
      id: 'factory_list_attention',
      description: 'What in one Factory needs a person now: failures, proposals waiting for approval, runs waiting on a question. Read-only.',
      inputSchema: z.object({ factoryId, limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ factoryId: id, limit }) => read('factory_list_attention', id, { limit: limit ?? 10 }),
    }),

    factory_session_status: createTool({
      id: 'factory_session_status',
      description:
        "Whether a Factory side session (e.g. a question asked from this request) has answered yet, and its answer. Read-only.",
      inputSchema: z.object({ factoryId, sessionId: z.string().trim().min(1).max(128) }),
      execute: async ({ factoryId: id, sessionId }) => guarded(() => host.factorySessionStatus(owner, { factoryId: id, sessionId })),
    }),

    factory_propose_ask: createTool({
      id: 'factory_propose_ask',
      description:
        "Propose asking a Factory a question about this request (it starts a side session there, which costs). Nothing runs until the person confirms in the thread; once they do, the answer comes back into this request.",
      inputSchema: z.object({
        factoryId,
        question: z.string().trim().min(1).max(8000).describe('The question, self-contained: the Factory sees only this.'),
        reason: z.string().trim().max(500).optional().describe('One sentence for the person: why ask.'),
      }),
      execute: async ({ factoryId: id, question, reason }) =>
        propose({ kind: 'ask', factoryId: id, question, ...(reason ? { reason } : {}), proposedBy: 'agent' }),
    }),

    factory_propose_hand_over: createTool({
      id: 'factory_propose_hand_over',
      description:
        "Propose handing this request to a Factory as a card (with its files and a link to the original). Nothing is created until the person confirms in the thread.",
      inputSchema: z.object({
        factoryId,
        title: z.string().trim().min(1).max(512).optional(),
        note: z.string().trim().max(4000).optional().describe('What the Factory should do, above the request’s own summary.'),
        reason: z.string().trim().max(500).optional(),
      }),
      execute: async ({ factoryId: id, title, note, reason }) =>
        propose({
          kind: 'hand_over',
          factoryId: id,
          ...(title ? { title } : {}),
          ...(note ? { note } : {}),
          ...(reason ? { reason } : {}),
          proposedBy: 'agent',
        }),
    }),
  };

  if (context.skills.length === 0) return tools;
  const names = context.skills.map(skill => skill.name) as [string, ...string[]];
  return {
    ...tools,
    assistant_read_skill: createTool({
      id: 'assistant_read_skill',
      description: 'Load the instructions of one of the skills the person picked for you, before following it.',
      inputSchema: z.object({ name: z.enum(names) }),
      execute: async ({ name }) =>
        guarded(async () => {
          const skill = await host.readSkill(owner, name);
          return skill ? { name: skill.name, instructions: skill.instructions } : { error: `There is no skill ${name} any more.` };
        }),
    }),
  };
}

export type AssistantTools = ReturnType<typeof createAssistantTools>;
