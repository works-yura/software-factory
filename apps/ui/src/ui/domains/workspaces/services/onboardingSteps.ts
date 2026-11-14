import type { OnboardingDraft, OnboardingStep } from './onboardingFlow';
import { i18n } from '../../../i18n';

/**
 * The page's numbered cards: Codebase, Harness (only while the server offers more than one) and Model.
 * Numbers follow the cards shown, so Model is second without a harness choice.
 */
export type OnboardingSection = OnboardingStep;

/** A section's label, translated when read: module constants outlive a language switch. */
export function onboardingSectionLabel(section: OnboardingSection): string {
  return i18n.t(`workspaces:onboarding.sections.${section}` as never);
}

/** The sections this page shows, in order. */
export function onboardingSections({ harnessChoice }: { harnessChoice: boolean }): OnboardingSection[] {
  return harnessChoice ? ['vcs', 'harness', 'model'] : ['vcs', 'model'];
}

export function onboardingSectionIndex(section: OnboardingSection, harnessChoice: boolean): number {
  return onboardingSections({ harnessChoice }).indexOf(section) + 1;
}

/** First section still missing a choice; Model once the codebase (and, with a choice, the harness) is settled. */
export function nextOnboardingStep(
  draft: OnboardingDraft,
  { harnessChoice }: { harnessChoice: boolean },
): OnboardingStep {
  if (!draft.repository) return 'vcs';
  if (harnessChoice && !draft.harness) return 'harness';
  return 'model';
}

/** A draft without a repository always reopens Codebase; otherwise the stored open section wins. */
export function restoredOnboardingStep(
  saved: OnboardingStep | undefined,
  draft: OnboardingDraft,
  options: { harnessChoice: boolean },
): OnboardingStep {
  if (!draft.repository) return 'vcs';
  if (saved === 'harness' && !options.harnessChoice) return 'model';
  return saved ?? nextOnboardingStep(draft, options);
}
