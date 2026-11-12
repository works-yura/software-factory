import { OnboardingProgress } from './onboarding/OnboardingProgress';
import { onboardingSteps, onboardingStepMeta, restoredOnboardingStep } from '../services/onboardingSteps';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useCompleteFactorySetup } from '../hooks/useCompleteFactorySetup';
import type { SourceControlRepository } from '../services/github';
import { connectGithub, manageGithubConnection } from '../services/github';
import {
  persistOnboardingDraft,
  persistOnboardingReviewReturn,
  readOnboardingDraft,
  readOnboardingReviewReturn,
  persistOnboardingStep,
  readOnboardingStep,
} from '../services/onboardingFlow';
import type { OnboardingDraft, OnboardingStep as Step } from '../services/onboardingFlow';
import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft } from 'lucide-react';
import { LogoWithoutText } from '@mastra/playground-ui/components/Logo';
import { OnboardingPreview } from './onboarding/preview/OnboardingPreview';
import type { ProviderConnectionMethod } from '../hooks/useProviderConnection';
import { InitialFactoryStep } from './InitialFactoryStep';
import { ModelProviderFactoryStep } from './ModelProviderFactoryStep';
import { VcsFactoryStep } from './VcsFactoryStep';
import { OnboardingReviewStep, turnHarnessModelTitle } from './onboarding/OnboardingReviewStep';
import { isTurnHarness } from '../services/turnHarness';
import { OnboardingHarnessStep, OnboardingTurnHarnessStep } from './onboarding/OnboardingCommandRows';
import { useHarnessChoices } from '../../../../hooks/useHarnessChoices';
import type { FactoryHarness } from '../services/github';

interface StepPreview {
  repository?: SourceControlRepository;
  providerId?: string;
  method?: ProviderConnectionMethod;
  model?: string;
}

function shownModel(previewedModel?: string, previewedProvider?: string, savedModel?: string) {
  if (previewedModel) return previewedModel;
  if (previewedProvider) return undefined;
  return savedModel;
}

export function FactoryOnboarding({ local }: { local: boolean }) {
  const { t } = useTranslation('workspaces');
  const { baseUrl } = useApiConfig();
  const complete = useCompleteFactorySetup({ local });
  const [draft, setDraft] = useState<OnboardingDraft>(readOnboardingDraft);
  const [step, setStep] = useState<Step>(() => restoredOnboardingStep(readOnboardingStep(), draft));
  const [returnToReview, setReviewReturn] = useState(readOnboardingReviewReturn);
  const setReturnToReview = (value: boolean) => {
    persistOnboardingReviewReturn(value);
    setReviewReturn(value);
  };
  const [githubRedirecting, setGithubRedirecting] = useState(false);
  const [preview, setPreview] = useState<StepPreview>({});
  const previewWith = (patch: StepPreview) => setPreview(current => ({ ...current, ...patch }));

  const updateDraft = (next: OnboardingDraft) => {
    persistOnboardingDraft(next);
    setDraft(next);
  };
  const goTo = (next: Step) => {
    persistOnboardingStep(next);
    setStep(next);
    setPreview({});
    complete.reset();
  };
  const advance = (next: Step) => {
    goTo(returnToReview ? 'review' : next);
    setReturnToReview(false);
  };
  const harnesses = useHarnessChoices();
  // A pick only counts while the server still runs it and this person can run it (ADR-0036); while that loads, the draft stands.
  const drafted = harnesses.choices.find(choice => choice.descriptor.id === draft.harness);
  const harness: FactoryHarness =
    draft.harness && (harnesses.isPending || drafted?.usable) ? draft.harness : 'mastra';
  const turn = isTurnHarness(harness) ? harness : undefined;
  // The harness step shows only when there is a choice; a draft resumed on it keeps it in view.
  const harnessChoice = harnesses.choices.filter(choice => choice.usable).length > 1 || step === 'harness' || turn !== undefined;
  const committedDraft: OnboardingDraft = harnessChoice ? { ...draft, harness } : { ...draft, harness: undefined };
  const steps = onboardingSteps({ harnessChoice });
  const stepIndex = steps.indexOf(step);
  const previousStep = stepIndex > 0 ? steps[stepIndex - 1] : undefined;
  const repository = preview.repository ?? draft.repository;
  const turnModelLabel = turn && draft.harnessModel !== undefined ? turnHarnessModelTitle(turn, draft.harnessModel) : undefined;
  const model = turn ? turnModelLabel : shownModel(preview.model, preview.providerId, draft.model?.modelId);
  const meta = onboardingStepMeta(step, local, harness);

  return (
    <main className="onboarding-page bg-background text-foreground min-h-dvh pb-20">
      <div className="onboarding-layout grid min-h-[calc(100dvh-5rem)] w-full grid-cols-1 min-[900px]:grid-cols-[minmax(400px,44%)_minmax(0,1fr)]">
        <section className="onboarding-form-column relative z-3 flex min-w-0 flex-col px-6 py-5 min-[900px]:px-10 min-[900px]:py-8 lg:px-12 xl:px-16">
          <div className="onboarding-brand mb-4 flex items-center gap-3 min-[900px]:mb-8">
            <LogoWithoutText className="w-6" aria-hidden="true" />
            <Txt variant="label">Factory</Txt>
          </div>
          <div className="onboarding-content w-full max-w-lg min-[900px]:pt-20">
            <div className="onboarding-back mb-6">
              <div className="h-8">
                {previousStep && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReturnToReview(false);
                      goTo(previousStep);
                    }}
                    aria-label={t('onboarding.backLabel')}
                    disabled={complete.isPending}
                  >
                    <ArrowLeft aria-hidden="true" />
                    {t('actions.back')}
                  </Button>
                )}
              </div>
            </div>

            <Txt as="h1" variant="hero" className="onboarding-heading min-h-[2lh] max-w-lg text-balance">
              {meta.title}
            </Txt>
            {meta.description && (
              <Txt
                as="p"
                variant="caption"
                tone="muted"
                className="onboarding-description mt-3 min-h-[2lh] max-w-md lg:mt-4"
              >
                {meta.description}
              </Txt>
            )}

            <div key={step} data-step={step} className="onboarding-form onboarding-reveal mt-6 w-full lg:mt-8">
              {step === 'initial' && <InitialFactoryStep onContinue={() => goTo('vcs')} />}
              {step === 'vcs' && (
                <VcsFactoryStep
                  initialRepository={draft.repository}
                  githubRedirecting={githubRedirecting}
                  onConnect={() => {
                    setGithubRedirecting(true);
                    persistOnboardingStep('vcs');
                    connectGithub(baseUrl);
                  }}
                  onManageConnection={() => {
                    persistOnboardingStep('vcs');
                    manageGithubConnection(baseUrl);
                  }}
                  onPreviewRepository={previewed => previewWith({ repository: previewed })}
                  onSelectRepository={repo => {
                    updateDraft({ ...draft, repository: repo });
                    advance(harnessChoice ? 'harness' : 'model-provider');
                  }}
                />
              )}
              {step === 'harness' && (
                <OnboardingHarnessStep
                  label={meta.title}
                  selected={draft.harness ?? (returnToReview ? 'mastra' : undefined)}
                  onSelect={picked => {
                    const changed = picked !== harness;
                    updateDraft({ ...draft, harness: picked });
                    // Another harness needs its own model pick before review.
                    if (changed) goTo('model-provider');
                    else advance('model-provider');
                  }}
                />
              )}
              {step === 'model-provider' && turn && (
                <OnboardingTurnHarnessStep
                  key={turn}
                  label={meta.title}
                  harness={turn}
                  onPick={harnessModel => {
                    updateDraft({ ...draft, harness: turn, harnessModel });
                    advance('review');
                  }}
                />
              )}
              {step === 'model-provider' && !turn && (
                <ModelProviderFactoryStep
                  initialChoice={draft.model}
                  onPreviewModel={previewed => previewWith({ model: previewed })}
                  onPreviewProvider={(providerId, method) => previewWith({ providerId, method, model: undefined })}
                  onComplete={model => {
                    updateDraft({ ...draft, model });
                    advance('review');
                  }}
                />
              )}
              {step === 'review' && (
                <OnboardingReviewStep
                  draft={committedDraft}
                  local={local}
                  harnessChoice={harnessChoice}
                  pending={complete.isPending}
                  error={complete.error?.message}
                  onConfirm={() => {
                    if (!complete.isPending) complete.mutate(committedDraft);
                  }}
                  onEdit={target => {
                    setReturnToReview(true);
                    goTo(target);
                  }}
                />
              )}
            </div>
          </div>
        </section>

        <OnboardingPreview
          step={step}
          local={local}
          repository={repository}
          model={model}
          providerId={turn ? undefined : (preview.providerId ?? draft.model?.providerId)}
          connectionMethod={turn ? undefined : (preview.method ?? draft.model?.method)}
        />
      </div>
      <OnboardingProgress step={step} editingReview={returnToReview} harnessChoice={harnessChoice} />
    </main>
  );
}
