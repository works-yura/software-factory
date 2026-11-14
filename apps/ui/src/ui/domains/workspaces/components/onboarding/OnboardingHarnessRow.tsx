import type { FactoryHarness } from '../../services/github';
import { translator } from '../../../../i18n/t';
import { OnboardingDoneRow, OnboardingNextRow } from './OnboardingStepRow';
import type { ChangeSectionProps } from './OnboardingStepRow';

const tk = translator('workspaces');

const HARNESS_TITLE: Record<string, string> = {
  mastra: 'createFactory.harness.mastra.title',
  'claude-code': 'createFactory.harness.claudeCode.title',
  codex: 'createFactory.harness.codex.title',
};

/** Harness while closed: what the Factory's agents run on, or a preview until it is chosen. */
export function OnboardingHarnessRow({
  harness,
  index,
  ...change
}: ChangeSectionProps & { harness?: FactoryHarness; index: number }) {
  const title = harness ? HARNESS_TITLE[harness] : undefined;
  if (!title) return <OnboardingNextRow section="harness" index={index} hint={tk('onboarding.harnessHint')} />;
  return <OnboardingDoneRow section="harness" value={tk(title)} {...change} />;
}
