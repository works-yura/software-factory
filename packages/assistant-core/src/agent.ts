/**
 * The per-person agent (ADR-0051): one Mastra Agent definition, built for each turn with its
 * owner's model, remembering under the Mastra memory resource `assistant:<orgId>:<userId>` with
 * one thread per request. It reads what the person brought (screenshots by vision) and reports to
 * the person only. From phase 3 it has tools bound to its owner (`tools.ts`), the person's own
 * instructions appended to its own, and the skills the person picked (loaded on demand).
 */
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { IMAGE_MIMES } from './files.ts';
import type { AssistantBrain, AssistantMemory, BrainFile, BrainTurn } from './ports.ts';
import { AssistantTurnError } from './turn-failure.ts';
import type { AssistantOwner } from './types.ts';
import { assistantResourceId, assertOwner } from './types.ts';

export const ASSISTANT_AGENT_INSTRUCTIONS = [
  'You are «Помічник», the personal assistant of one person in their organization.',
  'Colleagues and clients send this person messages, screenshots and files; the person brings each one to you as a request.',
  'For a new request: look closely at every screenshot and file, then say briefly who is asking what, what you think the answer or next step is, and whether one of the organization’s Factories (its software agents) should be asked or given the task.',
  'When a Factory’s answer arrives, give the person a short conclusion from it and what to reply.',
  'Some requests come from the person’s chats (ClickUp): a colleague’s message read there, not written to you. Report to the person what they want; never answer the colleague.',
  'You report to this person only. Never write as if to the colleague or client, and never claim you sent anything to anyone.',
  'You have tools: the person’s other requests and notes (you may keep a note for them), the chats they turned on (read for context only), and the organization’s Factories as the person (find and inspect cards, what needs attention, whether a side session answered).',
  'Asking a Factory and handing a request over change something outside: you can only propose them (factory_propose_ask, factory_propose_hand_over); the person confirms or cancels in the thread. Say what you proposed and why; never say it was done.',
  'Use tools only when they help this request; do not read things for their own sake.',
  'Answer in the language the person writes in. Be brief and concrete; use Markdown lists where they help.',
].join(' ');

/** The base instructions, the skills the person picked, then the person's own instructions. */
export function assistantInstructions(input: { base?: string; instructions?: string; skills?: Array<{ name: string; description: string }> }): string {
  const parts = [input.base ?? ASSISTANT_AGENT_INSTRUCTIONS];
  if (input.skills?.length) {
    parts.push(
      [
        'Skills the person picked for you (load one with assistant_read_skill before following it, only when the request needs it):',
        ...input.skills.map(skill => `- ${skill.name}: ${skill.description}`),
      ].join('\n'),
    );
  }
  if (input.instructions?.trim()) {
    parts.push(`The person’s own instructions for you (they win over the defaults above, never over “report to the person only”):\n${input.instructions.trim()}`);
  }
  return parts.join('\n\n');
}

type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];

/** The organization's model for a turn: its credentials, never the server's. */
export interface AssistantModelResolver {
  /**
   * The model to run (`modelId`, or the organization's default when `null`) and the request
   * context its credentials resolve under. Throws when the organization has no model.
   */
  resolve(
    owner: AssistantOwner,
    modelId: string | null,
  ): Promise<{ model: AgentModel; requestContext?: RequestContext; modelId?: string }>;
}

const TEXT_FILE_LIMIT = 40_000;

/** What the model gets for one file: an image to look at, a PDF to read, text inline, or just its name. */
function filePart(file: BrainFile): Array<Record<string, unknown>> {
  if (IMAGE_MIMES.has(file.mime)) return [{ type: 'image', image: file.bytes, mimeType: file.mime }];
  if (file.mime === 'application/pdf') return [{ type: 'file', data: file.bytes, mimeType: file.mime, filename: file.name }];
  if (file.mime.startsWith('text/') || file.mime === 'application/json') {
    const text = new TextDecoder().decode(file.bytes.subarray(0, TEXT_FILE_LIMIT));
    return [{ type: 'text', text: `File ${file.name}:\n${text}` }];
  }
  return [{ type: 'text', text: `(Attached file ${file.name}, ${file.mime}, not readable here.)` }];
}

/** What the agent is asked to start its first report on a source request with. */
export const TOPIC_PREFIX = 'Topic:';

/**
 * Splits the agent's answer into the topic it named (first line `Topic: …`) and the report. An
 * answer without that line is all report.
 */
export function splitTopic(answer: string): { text: string; topic?: string } {
  const lines = answer.split('\n');
  const index = lines.findIndex(line => line.trim() !== '');
  const match = index >= 0 ? /^\s*\**\s*topic\s*:\s*\**\s*(.+?)\s*\**\s*$/i.exec(lines[index]!) : null;
  if (!match?.[1]) return { text: answer.trim() };
  const text = lines.slice(index + 1).join('\n').trim();
  return { text: text || answer.trim(), topic: match[1].replace(/\*+$/, '').trim().slice(0, 120) };
}

/** The user message of a turn: who wrote it, the request's topic line on the first turn, the files. */
export function turnMessage(turn: BrainTurn) {
  const { request, input } = turn;
  const header =
    input.author === 'digest'
      ? "Write the person's digest: what is open in their inbox, below. Group it — what needs them first, what waits on a Factory, what came from digest-only chats — one line each, with the sender. No preamble."
      : input.author === 'factory'
      ? `Factory ${request.factory?.factoryName ?? ''} answered the question about "${request.topic}":`
      : input.author === 'source'
        ? [
            turn.first
              ? `New message in the person's ${request.source} chat, from ${input.fromName ?? 'someone'}.`
              : `A new message in the same ${request.source} thread, from ${input.fromName ?? 'someone'}.`,
            ...(request.sourceUrl ? [`Original: ${request.sourceUrl}`] : []),
            ...(turn.first
              ? [`Start your answer with one line "${TOPIC_PREFIX} <what it is about, at most 80 characters>", then your report.`]
              : []),
          ].join('\n')
        : [
            `Request: ${request.topic}`,
            ...(request.fromName ? [`From: ${request.fromName}`] : []),
            ...(request.sourceUrl ? [`Original: ${request.sourceUrl}`] : []),
          ].join('\n');
  return {
    role: 'user' as const,
    content: [
      { type: 'text', text: input.text ? `${header}\n\n${input.text}` : header },
      ...input.files.flatMap(filePart),
    ],
  };
}

export function createAssistantMemory(storage: MastraCompositeStore): Memory {
  return new Memory({
    storage,
    options: { lastMessages: 40, semanticRecall: false, generateTitle: false, workingMemory: { enabled: false } },
  });
}

/** The agent on Mastra: built per turn with the owner's model, memory per owner, thread per request. */
export function createMastraAssistantBrain(options: {
  memory: Memory;
  models: AssistantModelResolver;
  instructions?: string;
}): AssistantBrain {
  return {
    async respond(turn) {
      assertOwner(turn.owner);
      const resolved = await options.models.resolve(turn.owner, turn.modelId);
      const { model, requestContext } = resolved;
      const modelId = resolved.modelId ?? turn.modelId;
      const agent = new Agent({
        id: 'factory-assistant',
        name: 'Помічник',
        instructions: assistantInstructions({
          ...(options.instructions ? { base: options.instructions } : {}),
          ...(turn.instructions ? { instructions: turn.instructions } : {}),
          ...(turn.skills ? { skills: turn.skills } : {}),
        }),
        model,
        memory: options.memory,
        ...(turn.tools ? { tools: turn.tools as ToolsInput } : {}),
      });
      let result: Awaited<ReturnType<typeof agent.generate>>;
      try {
        result = await agent.generate([turnMessage(turn)] as never, {
          memory: { resource: assistantResourceId(turn.owner), thread: turn.request.id },
          ...(requestContext ? { requestContext } : {}),
          maxSteps: turn.maxSteps ?? 8,
        });
      } catch (error) {
        // The thread names the model that failed; the cause stays as the detail.
        throw modelId ? new AssistantTurnError(modelId, error) : error;
      }
      const text = result.text?.trim();
      if (!text) throw new Error('The model returned an empty answer.');
      return turn.first && turn.input.author === 'source' ? splitTopic(text) : { text };
    },
  };
}

/** Erases the agent's memory: every thread under the owner's resource, or one request's thread. */
export function createAssistantMemoryEraser(storage: MastraCompositeStore): AssistantMemory {
  const store = async () => {
    const memory = await storage.getStore('memory');
    if (!memory) throw new Error('The Mastra memory store is unavailable; the assistant memory cannot be erased.');
    return memory;
  };
  return {
    async forget(owner) {
      const resourceId = assistantResourceId(owner);
      const memory = await store();
      const { threads } = await memory.listThreads({ filter: { resourceId }, perPage: false });
      for (const thread of threads) {
        // Belt and braces: the filter named the resource; never delete a thread of another.
        if (thread.resourceId !== resourceId) continue;
        await memory.deleteThread({ threadId: thread.id });
      }
    },
    async forgetThread(owner, requestId) {
      const resourceId = assistantResourceId(owner);
      const memory = await store();
      const thread = await memory.getThreadById({ threadId: requestId });
      if (!thread || thread.resourceId !== resourceId) return;
      await memory.deleteThread({ threadId: requestId });
    },
  };
}
