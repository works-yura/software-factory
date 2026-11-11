// The thread-read tool as a Mastra tool, for `@factory/harness-mastra`'s tool sets.
import { createTool } from "@mastra/core/tools";

import { OrchestratorMcpThreadReadInput, OrchestratorMcpThreadReadResult } from "./contracts.ts";
import type { ThreadReadSource } from "./historySource.ts";
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
