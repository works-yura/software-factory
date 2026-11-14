import { onboardingCreateReadiness } from './onboardingFlow';
import type { OnboardingDraft } from './onboardingFlow';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

/** Where the Model section stands while it has no model yet. */
export interface OnboardingModelState {
  /** Claude Code or Codex: the harness signs in on its own, so only its model is picked. */
  turnHarness: boolean;
  /** A Mastra provider is connected (its key saved or its sign-in done). */
  providerConnected: boolean;
  /** The connected provider's models are still on their way. */
  modelsLoading: boolean;
}

/**
 * Why Create is off, naming the one step still missing, so a disabled button never leaves the user
 * guessing. Undefined when nothing is missing, or while a connected provider's models are still loading:
 * its model is on the way, so no step is missing.
 */
export function createBlockedReason(draft: OnboardingDraft, model: OnboardingModelState): string | undefined {
  const readiness = onboardingCreateReadiness(draft);
  if (readiness.ready) return undefined;
  if (readiness.missing.includes('repository')) return tk('onboarding.blocked.repository');
  if (model.turnHarness) return tk('onboarding.blocked.harnessModel');
  if (!model.providerConnected) return tk('onboarding.blocked.connect');
  if (model.modelsLoading) return undefined;
  return tk('onboarding.blocked.model');
}
