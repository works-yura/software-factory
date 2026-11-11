// What a Claude Code Factory may pin, apart from the catalog: store and contracts read it without
// loading the Claude model manifest.

/** `ModelSelection.instanceId` of a Claude Code session: its model is a Claude catalog slug or CLI alias. */
export const CLAUDE_CODE_INSTANCE_ID = 'claude-code';

/**
 * Models a Claude Code Factory may pin, as the `claude` CLI's own aliases
 * (`claude --model opus`), so they follow the CLI's current Opus/Sonnet/Haiku.
 * The one list: @factory/store and @factory/contracts re-export it.
 */
export const CLAUDE_CODE_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type ClaudeCodeModel = (typeof CLAUDE_CODE_MODELS)[number];

export function isClaudeCodeModel(value: unknown): value is ClaudeCodeModel {
  return typeof value === 'string' && (CLAUDE_CODE_MODELS as readonly string[]).includes(value);
}
