import type { OnboardingDraft, OnboardingModelScope, OnboardingStep } from './onboardingFlow';
import { i18n } from '../../../i18n';
import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export const SETUP_LABELS: Readonly<Record<OnboardingModelScope, string>> = lazyLabels(
  ['factory', 'hybrid', 'user'],
  scope => `workspaces:onboarding.setups.${scope}.label`,
);

export function onboardingSteps(scope?: OnboardingModelScope, local = false): OnboardingStep[] {
  return [
    'initial',
    'vcs',
    'project-management',
    ...(local ? [] : (['model-setup'] as const)),
    ...(scope === 'user' ? [] : (['model-provider'] as const)),
    ...(scope === 'user' || scope === 'hybrid' ? (['personal-provider'] as const) : []),
    'review',
  ];
}

export function firstModelStep(scope?: OnboardingModelScope): OnboardingStep {
  return scope === 'user' ? 'personal-provider' : 'model-provider';
}

const ACCOUNT_STEPS: Partial<Record<OnboardingStep, true>> = {
  'model-setup': true,
  'model-provider': true,
  'personal-provider': true,
  review: true,
};

export function restoredOnboardingStep(saved: OnboardingStep, draft: OnboardingDraft, local: boolean): OnboardingStep {
  if (saved !== 'initial' && !draft.repository) return 'vcs';
  if (!ACCOUNT_STEPS[saved]) return saved;
  if (!local && !draft.modelScope) return 'model-setup';
  return onboardingSteps(draft.modelScope, local).includes(saved) ? saved : firstModelStep(draft.modelScope);
}

interface StepMeta {
  label: string;
  title: string;
  description?: string;
}

const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'initial',
  'vcs',
  'project-management',
  'model-setup',
  'model-provider',
  'personal-provider',
  'review',
];

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

export function onboardingStepMeta(step: OnboardingStep, scope?: OnboardingModelScope, local = false): StepMeta {
  if (step === 'model-provider')
    return {
      ...STEP_META[step],
      description: companyModelDescription(scope, local),
    };
  if (step === 'personal-provider')
    return {
      ...STEP_META[step],
      title: scope === 'hybrid' ? tk('onboarding.personalStep.hybridTitle') : tk('onboarding.personalStep.title'),
      description:
        scope === 'hybrid'
          ? tk('onboarding.personalStep.hybridDescription')
          : tk('onboarding.personalStep.description'),
    };
  const meta = STEP_META[step];
  return { label: meta.label, title: meta.title, ...(meta.description ? { description: meta.description } : {}) };
}

function companyModelDescription(scope: OnboardingModelScope | undefined, local: boolean) {
  if (local) return tk('onboarding.companyModel.local');
  if (scope === 'hybrid') return tk('onboarding.companyModel.hybrid');
  return tk('onboarding.companyModel.factory');
}
