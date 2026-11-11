// Errors. t3code used Schema.TaggedError; these keep the same `_tag`, fields and messages so a
// host can switch on `_tag` and send `{ _tag, ...fields, message }` over the wire.
import type { ProviderThreadId, RunId, ThreadId } from "./contracts.ts";

abstract class TaggedHandoffError<F extends object = object> extends Error {
  abstract readonly _tag: string;
  constructor(message: string, fields: F) {
    const cause = (fields as { cause?: unknown }).cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    Object.assign(this, fields);
  }
}

/** From t3code packages/provider-core/src/server/failure.ts. */
export class ContextHandoffBudgetError extends TaggedHandoffError {
  readonly _tag = "ContextHandoffBudgetError";
  constructor() {
    super(
      "The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.",
      {},
    );
  }
}

/** From t3code packages/provider-core/src/server/failure.ts. */
export class ContextHandoffBackgroundWorkError extends TaggedHandoffError {
  readonly _tag = "ContextHandoffBackgroundWorkError";
  constructor() {
    super(
      "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.",
      {},
    );
  }
}

/** From ContextHandoffDelivery.ts. */
export class ContextHandoffDeliveryUncertainError extends TaggedHandoffError {
  readonly _tag = "ContextHandoffDeliveryUncertainError";
  constructor() {
    super(
      "Historical context delivery is uncertain; replace the native thread before retrying.",
      {},
    );
  }
}

interface ContextHandoffPrepareErrorFields {
  readonly threadId: ThreadId;
  readonly targetRunId: RunId;
  readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
  readonly toProviderThreadId: ProviderThreadId;
  readonly cause?: unknown;
}

/** From ContextHandoffService.ts. */
export class ContextHandoffPrepareError extends TaggedHandoffError<ContextHandoffPrepareErrorFields> {
  readonly _tag = "ContextHandoffPrepareError";
  declare readonly threadId: ThreadId;
  declare readonly targetRunId: RunId;
  declare readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
  declare readonly toProviderThreadId: ProviderThreadId;
  constructor(fields: ContextHandoffPrepareErrorFields) {
    super(
      `Failed to prepare context handoff for run ${fields.targetRunId} in thread ${fields.threadId}.`,
      fields,
    );
  }
}

interface ProviderSwitchPlanErrorFields {
  readonly threadId: ThreadId;
  readonly targetProviderInstanceId: string;
  readonly cause?: unknown;
}

/** From ProviderSwitchService.ts. */
export class ProviderSwitchPlanError extends TaggedHandoffError<ProviderSwitchPlanErrorFields> {
  readonly _tag = "ProviderSwitchPlanError";
  declare readonly threadId: ThreadId;
  declare readonly targetProviderInstanceId: string;
  constructor(fields: ProviderSwitchPlanErrorFields) {
    super(
      `Cannot switch thread ${fields.threadId} to ${fields.targetProviderInstanceId}${typeof fields.cause === "string" ? `: ${fields.cause}` : "."}`,
      fields,
    );
  }
}

interface ThreadForkPlanErrorFields {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly cause?: unknown;
}

/** From ThreadForkService.ts. */
export class ThreadForkPlanError extends TaggedHandoffError<ThreadForkPlanErrorFields> {
  readonly _tag = "ThreadForkPlanError";
  declare readonly sourceThreadId: ThreadId;
  declare readonly targetThreadId: ThreadId;
  constructor(fields: ThreadForkPlanErrorFields) {
    super(
      typeof fields.cause === "string"
        ? fields.cause
        : `Cannot fork thread ${fields.sourceThreadId} into ${fields.targetThreadId}.`,
      fields,
    );
  }
}

/**
 * t3code's `ProjectionStoreThreadNotFoundError`: what a {@link HandoffHistorySource} throws for a
 * thread it does not have, so fork-ancestor walks stop instead of failing.
 */
export class HandoffThreadNotFoundError extends TaggedHandoffError<{ readonly threadId: ThreadId }> {
  readonly _tag = "HandoffThreadNotFoundError";
  declare readonly threadId: ThreadId;
  constructor(fields: { readonly threadId: ThreadId }) {
    super(`Thread ${fields.threadId} was not found.`, fields);
  }
}

export const isHandoffThreadNotFoundError = (error: unknown): error is HandoffThreadNotFoundError =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "HandoffThreadNotFoundError";
