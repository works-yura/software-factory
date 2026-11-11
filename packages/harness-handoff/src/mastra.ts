// The handoff in a Mastra run: `factory_thread_read` as a Mastra tool, and the input processor that
// gives a run the context a handoff left pending for it.
import type { MastraDBMessage } from '@mastra/core/agent-controller';
import type { ProcessInputArgs, ProcessLLMResponseArgs, Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';

import { OrchestratorMcpThreadReadInput, OrchestratorMcpThreadReadResult } from "./contracts.ts";
import type { ThreadReadSource } from "./historySource.ts";
import type { SessionHandoffs, TurnHandoff } from './sessionHandoffs.ts';
import { THREAD_READ_TOOL_DESCRIPTION, THREAD_READ_TOOL_NAME, readThread } from "./threadRead.ts";

/**
 * `factory_thread_read`. `sourceFor` gets the run's request context and returns the threads this
 * caller may read; its `getThread` throws for any other thread.
 */
export function createThreadReadTool(
  sourceFor: (requestContext: unknown) => ThreadReadSource | Promise<ThreadReadSource>,
) {
  return createTool({
    id: THREAD_READ_TOOL_NAME,
    description: THREAD_READ_TOOL_DESCRIPTION,
    inputSchema: OrchestratorMcpThreadReadInput,
    outputSchema: OrchestratorMcpThreadReadResult,
    execute: async (input, execution) =>
      readThread(await sourceFor(execution?.requestContext), input),
  });
}

/** The system-message tag the processor's context goes under. */
export const CONTEXT_HANDOFF_SYSTEM_TAG = 'factory-context-handoff';

function controllerThread(requestContext: RequestContext | undefined): string | undefined {
  const controller = requestContext?.get('controller') as { threadId?: unknown } | undefined;
  return typeof controller?.threadId === 'string' && controller.threadId ? controller.threadId : undefined;
}

function inputText(message: MastraDBMessage | undefined): string {
  const parts = (message?.content as { parts?: Array<{ type?: string; text?: string }> } | undefined)?.parts ?? [];
  return parts.flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n');
}

/**
 * Gives a Mastra run the history a handoff left pending for its thread: the session moved here
 * from another harness. The context goes in as a system message of this run only (never stored,
 * never in the person's message), and counts as delivered once the model answered the first step;
 * a run that fails before that leaves it pending, so the next run carries it.
 */
export class FactoryContextHandoffProcessor implements Processor {
  readonly id = 'factory-context-handoff';
  readonly name = 'Factory context handoff';
  readonly #handoffs: () => SessionHandoffs | undefined;
  readonly #inFlight = new Map<string, TurnHandoff>();

  constructor(handoffs: () => SessionHandoffs | undefined) {
    this.#handoffs = handoffs;
  }

  async processInput({ messageList, requestContext }: ProcessInputArgs) {
    const threadId = controllerThread(requestContext);
    const handoffs = this.#handoffs();
    if (!threadId || !handoffs) return messageList;
    const input = messageList.get.input.db().find(message => message.role === 'user' || (message.role as string) === 'signal');
    const handoff = await handoffs.forTurn({ threadId, userText: inputText(input) });
    if (!handoff) return messageList;
    messageList.addSystem({ role: 'system', content: handoff.context }, CONTEXT_HANDOFF_SYSTEM_TAG);
    this.#inFlight.set(threadId, handoff);
    return messageList;
  }

  async processLLMResponse({ requestContext, fromCache }: ProcessLLMResponseArgs) {
    const threadId = controllerThread(requestContext);
    const handoff = threadId ? this.#inFlight.get(threadId) : undefined;
    if (!threadId || !handoff || fromCache) return;
    this.#inFlight.delete(threadId);
    await handoff.delivered();
  }
}
