import type { FactoryHarness } from './github';
import type { OnboardingDraft, OnboardingStep } from './onboardingFlow';
import { i18n } from '../../../i18n';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

/** The steps this run walks; the harness step only when the server runs Claude Code or Codex. */
export function onboardingSteps({ harnessChoice = false }: { harnessChoice?: boolean } = {}): OnboardingStep[] {
  return harnessChoice
    ? ['initial', 'vcs', 'harness', 'model-provider', 'review']
    : ['initial', 'vcs', 'model-provider', 'review'];
}

export function restoredOnboardingStep(saved: OnboardingStep, draft: OnboardingDraft): OnboardingStep {
  if (saved !== 'initial' && !draft.repository) return 'vcs';
  return saved;
}

interface StepMeta {
  label: string;
  title: string;
  description?: string;
}

const ONBOARDING_STEPS: readonly OnboardingStep[] = ['initial', 'vcs', 'harness', 'model-provider', 'review'];

/** Step copy, translated when read: module constants outlive a language switch. */
function lazyStepMeta(step: OnboardingStep): StepMeta {
  const key = `workspaces:onboarding.steps.${step}`;
  const meta = {
    get label() {
      return i18n.t(`${key}.label` as never);
    },
    get title() {
      return i18n.t(`${key}.title` as never);
    },
  };
  if (!i18n.exists(`${key}.description`)) return meta;
  return Object.defineProperty(meta, 'description', {
    enumerable: true,
    get: () => i18n.t(`${key}.description` as never),
  }) as StepMeta;
}

export const STEP_META: Readonly<Record<OnboardingStep, StepMeta>> = Object.fromEntries(
  ONBOARDING_STEPS.map(step => [step, lazyStepMeta(step)]),
) as Record<OnboardingStep, StepMeta>;

export function onboardingStepMeta(step: OnboardingStep, local = false, harness?: FactoryHarness): StepMeta {
  if (step === 'model-provider' && (harness === 'claude-code' || harness === 'codex')) {
    const key = harness === 'codex' ? 'codex' : 'claudeCode';
    return {
      label: STEP_META[step].label,
      title: tk(`onboarding.${key}.title`),
      description: tk(`onboarding.${key}.description`),
    };
  }
  if (step === 'model-provider')
    return {
      ...STEP_META[step],
      description: companyModelDescription(local),
    };
  const meta = STEP_META[step];
  return { label: meta.label, title: meta.title, ...(meta.description ? { description: meta.description } : {}) };
}

function companyModelDescription(local: boolean) {
  if (local) return tk('onboarding.companyModel.local');
  return tk('onboarding.companyModel.factory');
}
