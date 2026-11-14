/**
 * The built-in harnesses' descriptors: what each agent harness can do, in one place the browser can
 * read. The server lists the harnesses it runs (`/web/config/features` → `harnesses`, from its
 * harness modules, ADR-0044); the UI asks a session's or a Factory's harness what it supports
 * instead of checking its id. The type lives with the harness contract (`@factory/harness/descriptor`).
 */
import type { HarnessDescriptor } from '@factory/harness/descriptor';

export type { HarnessDescriptor };

export const MASTRA_HARNESS: HarnessDescriptor = {
  id: 'mastra',
  label: 'Mastra',
  icon: 'mastra',
  modelScope: 'session',
  supports: {
    goal: true,
    thinkingLevel: true,
    sessionPermissions: true,
    imageAttachments: true,
    memory: true,
    knowledge: true,
    sandboxRecreate: true,
    sessionlessChat: true,
  },
  setup: { modelProvider: true },
};

export const CLAUDE_CODE_HARNESS: HarnessDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  icon: 'anthropic',
  modelScope: 'factory',
  supports: {
    goal: false,
    thinkingLevel: false,
    sessionPermissions: false,
    imageAttachments: false,
    memory: false,
    knowledge: false,
    sandboxRecreate: false,
    sessionlessChat: false,
  },
  setup: { modelProvider: false, accounts: { provider: 'anthropic', connector: 'claude-code' } },
};

/** OpenAI's Codex: the `codex` CLI's app-server on the server host, signed in with the members' ChatGPT sign-ins. */
export const CODEX_HARNESS: HarnessDescriptor = {
  id: 'codex',
  label: 'Codex',
  icon: 'openai',
  modelScope: 'factory',
  supports: {
    goal: false,
    thinkingLevel: false,
    sessionPermissions: false,
    imageAttachments: false,
    memory: false,
    knowledge: false,
    sandboxRecreate: false,
    sessionlessChat: false,
  },
  setup: { modelProvider: false, accounts: { provider: 'openai-codex', connector: 'codex' } },
};

/**
 * OpenCode: the `opencode` CLI's server on the server host, on OpenCode's own free models (no key,
 * no account), or signed in with one of the organization's OpenCode accounts (Settings → Connections
 * → OpenCode), whose paid models then show. Free models may use what they are sent to improve their
 * models (ADR-0043).
 */
export const OPENCODE_HARNESS: HarnessDescriptor = {
  id: 'opencode',
  label: 'OpenCode',
  icon: 'opencode',
  modelScope: 'factory',
  supports: {
    goal: false,
    thinkingLevel: false,
    sessionPermissions: false,
    imageAttachments: false,
    memory: false,
    knowledge: false,
    sandboxRecreate: false,
    sessionlessChat: false,
  },
  // Accounts are optional here: without one, OpenCode runs on its free models.
  setup: { modelProvider: false, accounts: { provider: 'opencode', connector: 'opencode', optional: true } },
};

/** Every harness this build knows, the base one first; the server's harness modules carry these descriptors. */
export const HARNESSES: readonly HarnessDescriptor[] = [MASTRA_HARNESS, CLAUDE_CODE_HARNESS, CODEX_HARNESS, OPENCODE_HARNESS];

/** The harness with this id; an unknown or missing id is Mastra, the harness sessions ran on before there was a choice. */
export function harnessById(id: string | null | undefined, available: readonly HarnessDescriptor[] = HARNESSES): HarnessDescriptor {
  return available.find(harness => harness.id === id) ?? HARNESSES.find(harness => harness.id === id) ?? MASTRA_HARNESS;
}
