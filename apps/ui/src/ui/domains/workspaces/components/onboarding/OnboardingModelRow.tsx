import { OnboardingDoneRow, OnboardingNextRow } from './OnboardingStepRow';
import type { ChangeSectionProps } from './OnboardingStepRow';

/** Model while closed: the model Create would submit, or a preview before that. */
export function OnboardingModelRow({
  model,
  detail,
  hint,
  index,
  ...change
}: ChangeSectionProps & { model?: string; detail?: string; hint: string; index: number }) {
  if (!model) return <OnboardingNextRow section="model" index={index} hint={hint} />;
  return <OnboardingDoneRow section="model" value={model} subValue={detail} {...change} />;
}
