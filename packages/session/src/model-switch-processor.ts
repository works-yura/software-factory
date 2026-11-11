import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraDBMessage } from '@mastra/core/agent-controller';
import type { ProcessInputArgs, Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';

import { ModelSelection } from '@factory/harness/models/contracts';
import { modelSwitchBetween } from '@factory/harness/models/selection';
import { mastraModelSelection } from '@factory/credentials/mastra-models';

/** `content.metadata` key of the selection a Mastra turn ran on, stamped on the input that started it. */
export const MODEL_SELECTION_METADATA_KEY = 'modelSelection';
/** `content.metadata` key of the `{ from, to }` marker on the input whose turn switched model or effort. */
export const MODEL_SWITCH_METADATA_KEY = 'modelSwitch';

export interface FactoryModelSwitchProcessorOptions {
  /** The thinking level a session runs at when its state names none (the Factory's default). */
  thinkingLevel?: (requestContext: RequestContext) => Promise<string | undefined>;
}

function isInput(message: MastraDBMessage): boolean {
  return message.role === 'user' || message.role === 'signal';
}

function stampedSelection(message: MastraDBMessage): ModelSelection | null {
  const parsed = ModelSelection.safeParse(message.content.metadata?.[MODEL_SELECTION_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Marks a model or effort switch in a Mastra thread, as t3code's `modelSwitchSince` marks a
 * run's user message. Each turn's first input is stamped with the selection the turn runs on
 * (`metadata.modelSelection`); when the latest earlier input in context ran another one, the input
 * also gets `metadata.modelSwitch = { from, to }`, which the chat draws as a divider. An earlier
 * input outside the loaded context marks nothing (no divider rather than a wrong one).
 */
export class FactoryModelSwitchProcessor implements Processor {
  readonly id = 'factory-model-switch';
  readonly name = 'Factory model switch';
  readonly #options: FactoryModelSwitchProcessorOptions;

  constructor(options: FactoryModelSwitchProcessorOptions = {}) {
    this.#options = options;
  }

  async processInput({ messageList, requestContext }: ProcessInputArgs) {
    const controller = requestContext?.get('controller') as AgentControllerRequestContext | undefined;
    const modelId = controller?.session?.modelId?.trim();
    const input = messageList.get.input.db().find(isInput);
    if (!modelId || !input || !requestContext) return messageList;
    const state = (controller?.getState?.() ?? controller?.state) as { thinkingLevel?: unknown } | undefined;
    const thinkingLevel =
      typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : await this.#options.thinkingLevel?.(requestContext);
    const to = mastraModelSelection(modelId, thinkingLevel);
    const inputIds = new Set(messageList.get.input.db().map(message => message.id));
    const from = messageList.get.all
      .db()
      .filter(message => !inputIds.has(message.id) && isInput(message))
      .map(stampedSelection)
      .findLast(selection => selection !== null);
    input.content.metadata = {
      ...input.content.metadata,
      [MODEL_SELECTION_METADATA_KEY]: to,
      ...modelSwitchBetween(from, to),
    };
    return messageList;
  }
}
