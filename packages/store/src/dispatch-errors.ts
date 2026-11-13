import type {
  FactoryDispatchFailureCode,
  StoredFactoryDispatchFailureCode,
} from './work-items/base.ts';

interface FactoryDispatchFailureMetadata {
  canRetry: boolean;
  label: string;
  /**
   * Only a person can fix it (e.g. by choosing the card's repository): the
   * dispatcher stops at once instead of retrying, and the person retries.
   */
  needsPerson?: boolean;
}

const FAILURE_METADATA = {
  session_unavailable: { canRetry: true, label: 'Factory session unavailable' },
  source_control_missing: { canRetry: true, label: 'Source-control connection unavailable' },
  source_repository_missing: { canRetry: true, label: 'Source repository unavailable' },
  source_repository_ambiguous: { canRetry: true, needsPerson: true, label: 'Choose a repository for this work item' },
  unsupported_provider_item: { canRetry: false, label: 'Unsupported provider work item' },
  notification_delivery_failed: { canRetry: true, label: 'Factory message delivery failed' },
  run_terminal_event_missing: { canRetry: false, label: 'Agent run terminal event was not observed' },
  run_incomplete: { canRetry: true, label: 'Agent run ended before completing the working phase' },
  skill_delivery_ambiguous: { canRetry: false, label: 'Factory skill delivery could not be confirmed' },
  run_overdue: { canRetry: false, label: 'Agent run is overdue' },
  repository_git_missing: { canRetry: false, label: 'Git is unavailable in the workspace' },
  repository_egress_blocked: { canRetry: false, label: 'Repository network access is blocked' },
  repository_clone_failed: { canRetry: true, label: 'Repository clone failed' },
  repository_pull_failed: { canRetry: true, label: 'Repository update failed' },
  repository_push_failed: { canRetry: true, label: 'Repository push failed' },
  repository_commit_failed: { canRetry: true, label: 'Repository commit failed' },
  repository_cli_missing: { canRetry: false, label: 'GitHub CLI is unavailable in the workspace' },
  repository_pr_failed: { canRetry: true, label: 'Pull request creation failed' },
  run_configuration_invalid: { canRetry: false, label: 'Run configuration rejected by provider' },
  run_credentials_unavailable: { canRetry: true, label: 'Model credentials unavailable for the run' },
  // The run's request carries no user, so every retry fails the same way; a person has to start it.
  run_user_unauthenticated: { canRetry: false, label: 'Run started without an authenticated user' },
  // The run's harness cannot start on this server (its CLI is not installed or not executable): every
  // retry fails the same way until someone installs it, so the run fails once and a person retries it.
  harness_not_configured: { canRetry: true, needsPerson: true, label: 'Agent CLI is not installed on the server' },
  // Every model account the run may use is out of usage: the run waits for the reset on its own,
  // and fails with this only once it has waited too long.
  run_usage_limited: { canRetry: true, label: 'Model usage limit reached' },
  run_failed: { canRetry: true, label: 'Agent run ended in error' },
  unknown: { canRetry: true, label: 'Factory automation failed' },
  // Retired: no path writes these any more, stored rows still read through here.
  plan_awaiting_approval: { canRetry: false, label: 'Plan waiting for review' },
  run_awaiting_input: { canRetry: false, label: 'Agent is waiting for an answer' },
} satisfies Record<StoredFactoryDispatchFailureCode, FactoryDispatchFailureMetadata>;

export class FactoryDispatchError extends Error {
  readonly code: FactoryDispatchFailureCode;

  constructor(code: FactoryDispatchFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'FactoryDispatchError';
  }
}

export function factoryDispatchFailureCode(error: unknown): FactoryDispatchFailureCode {
  return error instanceof FactoryDispatchError ? error.code : 'unknown';
}

export function factoryDispatchFailureMetadata(
  code: StoredFactoryDispatchFailureCode | null,
): FactoryDispatchFailureMetadata {
  return code === null ? FAILURE_METADATA.unknown : FAILURE_METADATA[code];
}
