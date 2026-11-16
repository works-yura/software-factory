/**
 * The per-person agent (ADR-0051): one Mastra Agent definition, built for each turn with its
 * owner's model, remembering under the Mastra memory resource `assistant:<orgId>:<userId>` with
 * one thread per request. It reads what the person brought (screenshots by vision) and reports to
 * the person only. It has tools bound to its owner (`tools.ts`); its system prompt is the person's
 * version of the base document (or the shipped one), the skills index, and a guard no edit removes.
 */
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { IMAGE_MIMES } from './files.ts';
import { assistantInstructions } from './instructions.ts';
import type { AssistantBrain, AssistantMemory, BrainFile, BrainTurn } from './ports.ts';
import { AssistantTurnError } from './turn-failure.ts';
import type { AssistantOwner } from './types.ts';
import { assistantResourceId, assertOwner } from './types.ts';

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

/**
 * The head of a turn after a server restart (`resumed`): what the agent does then, carried in the
 * turn itself so it holds whatever the person's own instructions say.
 */
export const RESUME_NOTE = [
  'Сервер перезапускався під час твоєї роботи над цим зверненням. Перевір, на чому зупинився, і продовж.',
  '(The server restarted while you worked on this request. Check the thread first: confirmed actions and events in it already happened — do not redo or re-propose them. If a Factory was asked, check its answer with factory_session_status. Then finish the step and report briefly.)',
].join('\n');

/** The user message of a turn: who wrote it, the request's topic line on the first turn, the files. */
export function turnMessage(turn: BrainTurn) {
  const { request, input } = turn;
  const header =
    input.author === 'resumed'
      ? RESUME_NOTE
      : input.author === 'approved'
      ? 'The person approved what you proposed; it ran. Its result is below. Carry on from it and report to the person.'
      : input.author === 'digest'
      ? "Write the person's digest: what is open in their inbox, below. Group it — what needs them first, what waits on a Factory — one line each, with the sender. No preamble."
      : input.author === 'factory'
      ? `Factory ${request.factory?.factoryName ?? ''} answered the question about "${request.topic}":`
      : input.author === 'source'
        ? [
            turn.first
              ? `${input.fromName ?? 'Someone'} tagged you in the person's ${request.source} chat. Quoted below: the messages the tag points at (oldest first, with their authors); after them, what the tagger asked you to do — if nothing, read the messages and report what needs the person.`
              : `${input.fromName ?? 'Someone'} tagged you again in the same ${request.source} thread: the messages since the last tag, quoted, then what they ask now.`,
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
  const folder = turn.workspaceFolder
    ? `\n\nYour workspace folder for this request: ${turn.workspaceFolder} (the request's files are there; downloads go to ${turn.workspaceFolder}/downloads). Work there; what you save there the person sees under the request's Files.`
    : '';
  return {
    role: 'user' as const,
    content: [
      { type: 'text', text: input.text ? `${header}${folder}\n\n${input.text}` : `${header}${folder}` },
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
        instructions:
          turn.systemPrompt ??
          assistantInstructions({ ...(options.instructions ? { base: options.instructions } : {}), ...(turn.skills ? { skills: turn.skills } : {}) }),
        model,
        memory: options.memory,
        ...(turn.tools ? { tools: turn.tools as ToolsInput } : {}),
        ...(turn.workspace ? { workspace: turn.workspace } : {}),
      });
      // Streamed, then read whole: some providers take only streaming calls (the Codex backend behind a
      // ChatGPT sign-in answers a plain call with «Stream must be set to true»).
      let streamed: string | undefined;
      try {
        const stream = await agent.stream([turnMessage(turn)] as never, {
          memory: { resource: assistantResourceId(turn.owner), thread: turn.request.id },
          ...(requestContext ? { requestContext } : {}),
          maxSteps: turn.maxSteps ?? 8,
        });
        streamed = await stream.text;
      } catch (error) {
        // The thread names the model that failed; the cause stays as the detail.
        throw modelId ? new AssistantTurnError(modelId, error) : error;
      }
      const text = streamed?.trim();
      if (!text) throw new Error('The model returned an empty answer.');
      const answer = turn.first && turn.input.author === 'source' ? splitTopic(text) : { text };
      return modelId ? { ...answer, modelId } : answer;
    },
    async probe(owner, modelId) {
      assertOwner(owner);
      const resolved = await options.models.resolve(owner, modelId);
      const usedId = resolved.modelId ?? modelId;
      const agent = new Agent({
        id: 'factory-assistant-probe',
        name: 'Помічник (model check)',
        instructions: 'Answer with the single word OK.',
        model: resolved.model,
      });
      try {
        const stream = await agent.stream('Reply with the single word OK.', {
          ...(resolved.requestContext ? { requestContext: resolved.requestContext } : {}),
          maxSteps: 1,
        });
        const text = await stream.text;
        return { modelId: usedId ?? null, text: (text ?? '').trim().slice(0, 200) };
      } catch (error) {
        throw usedId ? new AssistantTurnError(usedId, error) : error;
      }
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
