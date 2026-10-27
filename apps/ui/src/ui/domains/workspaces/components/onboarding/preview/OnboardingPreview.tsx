import { Txt } from '@mastra/playground-ui/components/Txt';
import { GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProviderConnectionMethod } from '../../../hooks/useProviderConnection';
import type { OnboardingStep } from '../../../services/onboardingFlow';
import { OnboardingAccountsPreview } from './OnboardingAccountsPreview';
import { SketchLabel } from './SketchLabel';
import { OnboardingIllustration } from './OnboardingIllustration';
import type { DrawingScene } from './onboarding-drawing';
import '../onboarding-preview.css';
import { translator } from '../../../../../i18n/t';

const tk = translator('workspaces');

export interface OnboardingPreviewProps {
  step: OnboardingStep;
  local?: boolean;
  repository?: { name: string; fullName: string; defaultBranch: string };
  model?: string;
  providerId?: string;
  connectionMethod?: ProviderConnectionMethod;
}

function sceneForStep(step: OnboardingStep): DrawingScene {
  if (step === 'initial') return 'factory';
  if (step === 'vcs') return 'codebase';
  return 'accounts';
}

function OnboardingScene({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="onboarding-scene absolute inset-0" data-active={active} inert={!active}>
      {children}
    </div>
  );
}

function OnboardingWelcomePreview() {
  return (
    <section aria-label={tk('welcomePreview.label')} className="relative h-full">
      <SketchLabel x={20} y={300} width={112}>
        <Txt variant="meta" tone="muted">
          {tk('welcomePreview.ideas')}
        </Txt>
      </SketchLabel>
      <SketchLabel x={147} y={42} width={126}>
        <Txt variant="meta" tone="muted">
          {tk('welcomePreview.build')}
        </Txt>
      </SketchLabel>
      <SketchLabel x={288} y={300} width={110}>
        <Txt variant="meta" tone="muted">
          {tk('welcomePreview.ship')}
        </Txt>
      </SketchLabel>
    </section>
  );
}

function OnboardingCodebasePreview({ repository }: Pick<OnboardingPreviewProps, 'repository'>) {
  return (
    <section aria-label={tk('codebasePreview.label')} className="relative h-full">
      <SketchLabel x={279} y={220} width={114}>
        <Txt variant="meta" tone="muted">
          {tk('codebasePreview.factory')}
        </Txt>
      </SketchLabel>
      <SketchLabel x={25} y={256} width={220}>
        <Txt variant="caption" className="truncate">
          {repository?.fullName ?? tk('codebasePreview.repository')}
        </Txt>
        <div className="text-muted-foreground mt-2 flex items-center gap-2">
          <GitBranch className="size-3 shrink-0" />
          <Txt variant="meta" tone="muted">
            {repository?.defaultBranch ?? tk('codebasePreview.branch')}
          </Txt>
        </div>
      </SketchLabel>
    </section>
  );
}

export function OnboardingPreview({
  step,
  local = false,
  repository,
  model,
  providerId,
  connectionMethod,
}: OnboardingPreviewProps) {
  const scene = sceneForStep(step);
  return (
    <aside className="onboarding-preview min-w-0 px-8 xl:px-12" aria-hidden="true">
      <div className="onboarding-diagram relative mx-auto w-full max-w-150">
        <OnboardingIllustration scene={scene} mode="shared" />
        <OnboardingScene active={step === 'initial'}>
          <OnboardingWelcomePreview />
        </OnboardingScene>
        <OnboardingScene active={step === 'vcs'}>
          <OnboardingCodebasePreview repository={repository} />
        </OnboardingScene>
        <OnboardingScene active={scene === 'accounts'}>
          <OnboardingAccountsPreview
            step={step}
            local={local}
            model={model}
            providerId={providerId}
            connectionMethod={connectionMethod}
          />
        </OnboardingScene>
      </div>
    </aside>
  );
}
