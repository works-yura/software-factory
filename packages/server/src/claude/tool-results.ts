import { CLAUDE_FACTORY_MCP_SERVER } from './harness.ts';

const FACTORY_TOOL_PREFIX = `mcp__${CLAUDE_FACTORY_MCP_SERVER}__`;

/**
 * The name a Factory tool has in a Mastra run (and in the board's rules), for a
 * call a Claude Code transcript stores as its MCP client names it
 * (`mcp__factory__<tool>`). Other names pass through.
 */
export function claudeFactoryToolName(toolName: string): string {
  return toolName.startsWith(FACTORY_TOOL_PREFIX) ? toolName.slice(FACTORY_TOOL_PREFIX.length) : toolName;
}

/** The parts of a Claude session's chat channel the tool-result rules need. */
export interface ClaudeToolResultSource {
  subscribe(listener: (event: { type: string }) => void): () => void;
  /** Resolves once everything recorded so far is stored. */
  flushed(): Promise<void>;
}

/**
 * Runs the board's tool-result rules on a Claude Code session's completed tool
 * calls, as `FactoryPhaseStateProcessor.processInputStep` does for a Mastra
 * run's at its next step: once a call's result is stored in the session's
 * thread, `reconcile` ingests the thread (the processor's `reconcileBinding`,
 * idempotent per tool call). Calls run one after another.
 */
export function observeClaudeToolResults(
  channel: ClaudeToolResultSource,
  reconcile: () => Promise<void>,
): () => void {
  let chain: Promise<void> = Promise.resolve();
  return channel.subscribe(event => {
    if (event.type !== 'tool_end') return;
    chain = chain
      .then(async () => {
        await channel.flushed();
        await reconcile();
      })
      .catch(error => console.warn('[factory] Could not run the tool-result rules for a Claude Code session', error));
  });
}
