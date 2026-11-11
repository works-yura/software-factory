/**
 * The port event triggers subscribe through (Observer). An adapter maps the provider event stream
 * (GitHub/GitLab webhooks, ClickUp polls, board moves) onto `IntakeEvent`s; a trigger kind built
 * with `eventTriggerKind` (`@factory/runtime`) listens, matches each event against its armed rules
 * and fires them. Adding «PR змерджено» is one adapter that publishes `pull_request.merged` plus
 * one trigger kind whose config says which events it takes.
 */

import type { IntakeScope } from './rule.ts';

export interface IntakeEvent {
  /** The provider's own id for this event: a redelivered event keeps it, so its fire runs once. */
  id: string;
  /** What happened, e.g. `pull_request.merged`, `work_item.created`. */
  type: string;
  /** The Factory project it happened in. */
  scope: IntakeScope;
  occurredAt: Date;
  /** Text and number facts a trigger's config may test and templates may read as `{payload.<key>}`. */
  facts: Readonly<Record<string, string | number | boolean | null>>;
}

export type IntakeEventListener = (event: IntakeEvent) => Promise<void>;

/** A stream of events; `subscribe` returns the unsubscribe. */
export interface IntakeEventSource {
  subscribe(listener: IntakeEventListener): () => void;
}
