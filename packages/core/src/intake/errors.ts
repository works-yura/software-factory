/**
 * Trigger-route domain errors. Kinds and the engine throw these; only the HTTP layer maps them to
 * status codes (`@factory/api`), and the engine records them on a fire as `failed`.
 */

export type IntakeErrorCode =
  /** A config that does not fit its kind. */
  | 'invalid_config'
  /** A kind this server has not registered. */
  | 'unknown_kind'
  /** The action's target is gone or can't take cards now, e.g. a deleted board. */
  | 'target_unavailable'
  /** The trigger's machinery is not up, e.g. no scheduler on this storage. */
  | 'trigger_unavailable';

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;

  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

/** A config that does not fit its kind. */
export class IntakeConfigError extends IntakeError {
  constructor(message: string) {
    super('invalid_config', message);
    this.name = 'IntakeConfigError';
  }
}

export class IntakeUnknownKindError extends IntakeError {
  constructor(side: 'trigger' | 'action' | 'policy', kind: string) {
    super('unknown_kind', `This server has no "${kind}" ${side}.`);
    this.name = 'IntakeUnknownKindError';
  }
}

export class IntakeTargetError extends IntakeError {
  constructor(message: string) {
    super('target_unavailable', message);
    this.name = 'IntakeTargetError';
  }
}

export class IntakeTriggerUnavailableError extends IntakeError {
  constructor(message: string) {
    super('trigger_unavailable', message);
    this.name = 'IntakeTriggerUnavailableError';
  }
}
