/**
 * What each agent harness can do, as data the server sends the UI (`/web/config/features` →
 * `harnesses`): the UI asks a session's or a Factory's harness what it supports instead of
 * checking its id. Each harness module carries its descriptor (`./module.ts`, ADR-0044);
 * `@factory/contracts` re-exports the type and the built-in descriptors. Browser-safe: data only.
 */
export interface HarnessDescriptor {
  id: string;
  label: string;
  /** Its logo key (`mastra`, `anthropic`, `openai`): what the UI draws beside its name. */
  icon: string;
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
    /**
     * A chat on the Factory's own resource with no stored session behind it
     * (`/factories/:id/new`). Without it a new chat starts as a personal
     * session, which this harness runs.
     */
    sessionlessChat: boolean;
  };
  /** What creating a Factory on this harness asks for. */
  setup: {
    /** A model provider and model (Mastra's providers). */
    modelProvider: boolean;
    /**
     * The members' sign-ins its turns run on: the credential-account provider they
     * are filed under, and the connector that connects them in Settings ›
     * Підключення (ADR-0036). Absent: no accounts. `optional`: runs work without one (OpenCode's
     * free models); an account adds what it unlocks.
     */
    accounts?: { provider: string; connector: string; optional?: boolean };
  };
}
