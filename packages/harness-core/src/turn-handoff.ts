// What a turn-based harness (Claude Code, Codex) asks its host for before a turn: context carried
// over from another conversation (`@factory/harness-handoff`). The host answers with the pending
// handoff a move from another harness left, or, when the harness could not resume its native
// conversation and starts a fresh one, the history that conversation held.

export interface TurnHandoffRequest {
  /**
   * `turn`: an ordinary turn, which carries any handoff still pending. `resume_failed`: the native
   * conversation could not be resumed and this turn starts a fresh one, which needs the history.
   */
  readonly reason: 'turn' | 'resume_failed';
  /** The person's request this turn sends; the context goes ahead of it and never shortens it. */
  readonly prompt: string;
  /** When the turn started: what the session stored from then on is this turn's own input. */
  readonly turnStartedAt: Date;
}

export interface TurnHandoffContext {
  /** Inline history, ahead of the prompt. */
  readonly context: string;
  /** Once the provider has the prompt that carried `context`. */
  delivered(): Promise<void>;
  /** When that prompt never reached the provider: the context stays pending for the next turn. */
  unsent(): Promise<void>;
}

/** The host hook: undefined when the turn carries nothing. */
export type TurnHandoffHook<Session> = (
  session: Session,
  request: TurnHandoffRequest,
) => Promise<TurnHandoffContext | undefined>;

/** The prompt with a handoff's context ahead of the person's request, which stays as written. */
export function promptWithTurnHandoff(handoff: Pick<TurnHandoffContext, 'context'> | undefined, prompt: string): string {
  return handoff?.context ? `${handoff.context}\n\nUser message:\n${prompt}` : prompt;
}
