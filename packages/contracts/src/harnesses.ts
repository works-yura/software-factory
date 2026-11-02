/**
 * What each agent harness can do, in one place. The server lists the
 * harnesses it runs (`/web/config/features` → `harnesses`); the UI asks a
 * session's or a Factory's harness what it supports instead of checking its
 * id, so a new harness is one entry here plus whatever screens are its own.
 */
export interface HarnessDescriptor {
  id: string;
  label: string;
  /**
   * Where the model is chosen: per session (the chat's model picker, `/model`)
   * or per Factory (Settings → Models; the chat only shows it).
   */
  modelScope: 'session' | 'factory';
  supports: {
    /** `/goal` and its pause, resume and clear. */
    goal: boolean;
    /** A per-session reasoning level (`/think`). */
    thinkingLevel: boolean;
    /** Per-session tool permission categories (`/permissions`, `/yolo`); otherwise the Factory's Behavior settings decide. */
    sessionPermissions: boolean;
    /** Images attached to a message. */
    imageAttachments: boolean;
    /** Observational memory and its settings (`/om`, Settings → Memory). */
    memory: boolean;
    /** Captures and recalls Factory knowledge. */
    knowledge: boolean;
    /** The session's sandbox can be recreated from the chat. */
    sandboxRecreate: boolean;
  };
  /** What creating a Factory on this harness asks for. */
  setup: {
    /** A model provider and model (Mastra's providers). */
    modelProvider: boolean;
    /** A Claude sign-in and a Claude model. */
    claudeSignIn: boolean;
  };
}

export const MASTRA_HARNESS: HarnessDescriptor = {
  id: 'mastra',
  label: 'Mastra',
  modelScope: 'session',
  supports: {
    goal: true,
    thinkingLevel: true,
    sessionPermissions: true,
    imageAttachments: true,
    memory: true,
    knowledge: true,
    sandboxRecreate: true,
  },
  setup: { modelProvider: true, claudeSignIn: false },
};

export const CLAUDE_CODE_HARNESS: HarnessDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  modelScope: 'factory',
  supports: {
    goal: false,
    thinkingLevel: false,
    sessionPermissions: false,
    imageAttachments: false,
    memory: false,
    knowledge: false,
    sandboxRecreate: false,
  },
  setup: { modelProvider: false, claudeSignIn: true },
};

export const HARNESSES: readonly HarnessDescriptor[] = [MASTRA_HARNESS, CLAUDE_CODE_HARNESS];

/** The harness with this id; an unknown or missing id is Mastra, the harness sessions ran on before there was a choice. */
export function harnessById(id: string | null | undefined, available: readonly HarnessDescriptor[] = HARNESSES): HarnessDescriptor {
  return available.find(harness => harness.id === id) ?? HARNESSES.find(harness => harness.id === id) ?? MASTRA_HARNESS;
}
