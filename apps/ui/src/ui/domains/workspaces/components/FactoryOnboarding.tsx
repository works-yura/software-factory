import { Button } from '@mastra/playground-ui/components/Button';
import { LogoWithoutText } from '@mastra/playground-ui/components/Logo';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { useEffect, useId, useRef, useState } from 'react';

import { useApiConfig } from '../../../../api/config';
import { useHarnessChoices } from '../../../../hooks/useHarnessChoices';
import { useCompleteFactorySetup } from '../hooks/useCompleteFactorySetup';
import { useOnboardingModel } from '../hooks/useOnboardingModel';
import type { ProviderConnectionMethod } from '../hooks/useProviderConnection';
import { createBlockedReason } from '../services/createBlockedReason';
import type { FactoryHarness, SourceControlRepository } from '../services/github';
import { connectGithub, manageGithubConnection } from '../services/github';
import {
  onboardingCreateReadiness,
  persistOnboardingDraft,
  persistOnboardingStep,
  readOnboardingDraft,
  readOnboardingStep,
} from '../services/onboardingFlow';
import type { OnboardingDraft, OnboardingStep } from '../services/onboardingFlow';
import { nextOnboardingStep, onboardingSectionIndex, restoredOnboardingStep } from '../services/onboardingSteps';
import { isTurnHarness, TURN_HARNESS_TEXT_KEY } from '../services/turnHarness';
import type { GitHubAppCallbackResult } from './GitHubAppCallbackHandler';
import { ModelProviderFactoryStep } from './ModelProviderFactoryStep';
import { OnboardingHarnessStep, OnboardingTurnHarnessStep } from './onboarding/OnboardingCommandRows';
import { OnboardingAccountMenu } from './onboarding/OnboardingAccountMenu';
import { OnboardingCodebaseRow } from './onboarding/OnboardingCodebaseRow';
import { OnboardingCreateNotice } from './onboarding/OnboardingCreateNotice';
import { OnboardingHarnessRow } from './onboarding/OnboardingHarnessRow';
import { OnboardingModelRow } from './onboarding/OnboardingModelRow';
import { OnboardingPageAction } from './onboarding/OnboardingPageAction';
import { OnboardingSlot } from './onboarding/OnboardingSlot';
import { OnboardingStepCard } from './onboarding/OnboardingStepCard';
import { OnboardingPreview } from './onboarding/preview/OnboardingPreview';
import { VcsFactoryStep } from './VcsFactoryStep';
import { translator } from '../../../i18n/t';
import './onboarding/onboarding.css';

const tk = translator('workspaces');

interface SectionPreview {
  repository?: SourceControlRepository;
  providerId?: string;
  method?: ProviderConnectionMethod;
  model?: string;
}

export interface FactoryOnboardingProps {
  local: boolean;
  githubCallback?: GitHubAppCallbackResult;
  onDismissGithubCallback: () => void;
}

/** How a turn-based harness's model reads: Claude's alias by its title, Codex's slug as it is. */
function turnModelTitle(harness: FactoryHarness, model: OnboardingDraft['harnessModel']) {
  if (model === undefined) return undefined;
  if (harness === 'codex') return model ?? tk('createFactory.codex.models.default.title');
  return tk(`createFactory.claudeCode.models.${model ?? 'default'}.title`);
}

/**
 * One page with the Codebase, Harness (when the server offers a choice) and Model sections; one is open,
 * the others summarise or preview. Create sits under the cards: it commits every section, and while it is
 * off, the line above it says what is still missing.
 */
export function FactoryOnboarding({ local, githubCallback, onDismissGithubCallback }: FactoryOnboardingProps) {
  const { baseUrl } = useApiConfig();
  const complete = useCompleteFactorySetup({ local });
  const [draft, setDraft] = useState<OnboardingDraft>(readOnboardingDraft);
  const harnesses = useHarnessChoices();
  // A pick only counts while the server still runs it and this person can run it (ADR-0036); while that loads, the draft stands.
  const drafted = harnesses.choices.find(choice => choice.descriptor.id === draft.harness);
  const harness: FactoryHarness =
    draft.harness && (harnesses.isPending || drafted?.usable) ? draft.harness : 'mastra';
  const turn = isTurnHarness(harness) ? harness : undefined;
  // The Harness card shows only when there is a choice; a draft that picked one keeps it in view.
  const harnessChoice = harnesses.choices.filter(choice => choice.usable).length > 1 || turn !== undefined;
  const [openStep, setOpenStep] = useState<OnboardingStep>(() =>
    restoredOnboardingStep(readOnboardingStep(), draft, { harnessChoice }),
  );
  // Restored before the harness choices answered, Harness may have no card to open: Model takes its place.
  const shownStep = openStep === 'harness' && !harnessChoice ? 'model' : openStep;
  const [githubRedirecting, setGithubRedirecting] = useState(false);
  const [preview, setPreview] = useState<SectionPreview>({});
  const showVisual = !useIsMobile(900);
  const mainRef = useRef<HTMLElement>(null);
  const focusOpenedSection = useRef(false);
  const createNoticeId = useId();

  // Continue and Change unmount with their section, so focus moves to the section that opened.
  // Only the open section has an h2.
  useEffect(() => {
    if (!focusOpenedSection.current) return;
    focusOpenedSection.current = false;
    mainRef.current?.querySelector('h2')?.focus();
  }, [openStep]);

  // Back from GitHub restores this page from the bfcache with the spinner still on; Connect must work again.
  useEffect(() => {
    const resetRedirect = (event: PageTransitionEvent) => {
      if (event.persisted) setGithubRedirecting(false);
    };
    window.addEventListener('pageshow', resetRedirect);
    return () => window.removeEventListener('pageshow', resetRedirect);
  }, []);

  // A ref, not a functional update: a provider connects after an await and must merge into the latest
  // draft, and the storage write has to stay out of the state updater.
  const latestDraft = useRef(draft);
  const updateDraft = (patch: Partial<OnboardingDraft>) => {
    // The create failure was about the old choices; a change means the user is acting on it.
    if (complete.isError) complete.reset();
    const next = { ...latestDraft.current, ...patch };
    latestDraft.current = next;
    persistOnboardingDraft(next);
    setDraft(next);
  };
  const open = (step: OnboardingStep) => {
    persistOnboardingStep(step);
    focusOpenedSection.current = true;
    setOpenStep(step);
    setPreview({});
    complete.reset();
  };
  const finish = (patch: Partial<OnboardingDraft>) => {
    updateDraft(patch);
    open(nextOnboardingStep(latestDraft.current, { harnessChoice }));
  };
  const change = (step: OnboardingStep) => ({ onChange: () => open(step), changeDisabled: complete.isPending });
  const model = useOnboardingModel({ draft, onDraftChange: updateDraft });

  // What Create submits: the draft with the harness this server runs and, on Mastra, the model shown.
  const submitted: OnboardingDraft = turn
    ? { ...draft, harness: turn }
    : { ...draft, harness: harnessChoice ? harness : undefined, model: model.choice };
  const ready = onboardingCreateReadiness(submitted).ready;
  const blockedReason = createBlockedReason(submitted, {
    turnHarness: turn !== undefined,
    providerConnected: model.connectedProvider !== undefined,
    modelsLoading: model.models.isPending,
  });
  const createFactory = () => {
    if (complete.isPending || !ready) return;
    updateDraft(submitted);
    complete.mutate(submitted);
  };

  const connectGithubFromOnboarding = () => {
    onDismissGithubCallback();
    setGithubRedirecting(true);
    persistOnboardingStep('vcs');
    connectGithub(baseUrl);
  };
  const manageGithubFromOnboarding = () => {
    persistOnboardingStep('vcs');
    manageGithubConnection(baseUrl);
  };

  const modelTitle = turn ? turnModelTitle(turn, draft.harnessModel) : model.choice?.modelId;
  const modelHint = turn ? tk(`onboarding.${TURN_HARNESS_TEXT_KEY[turn]}.hint`) : tk('onboarding.modelHint');
  const modelDetail = turn
    ? tk(turn === 'codex' ? 'review.codexModelDetail' : 'review.claudeModelDetail')
    : tk(local ? 'review.sharedModel.local' : 'review.sharedModel.factory');
  const previewModel = turn ? modelTitle : (preview.model ?? (preview.providerId ? undefined : model.choice?.modelId));
  const index = (section: OnboardingStep) => onboardingSectionIndex(section, harnessChoice);

  return (
    <div className="onboarding-page bg-background text-foreground min-h-dvh min-[900px]:grid min-[900px]:grid-cols-[minmax(0,600px)_minmax(0,1fr)]">
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <LogoWithoutText className="w-6" aria-hidden="true" />
            <Txt as="span" variant="label">
              Factory
            </Txt>
          </div>
          <OnboardingAccountMenu />
        </header>
        <main
          ref={mainRef}
          className="mx-auto flex w-full max-w-[520px] flex-col gap-2 px-4 pt-6 pb-6 min-[900px]:px-5"
        >
          <Txt as="h1" variant="display" className="mb-4">
            {tk('onboarding.title')}
          </Txt>
          <OnboardingSlot>
            {shownStep === 'vcs' ? (
              <VcsFactoryStep
                index={index('vcs')}
                initialRepository={draft.repository}
                githubRedirecting={githubRedirecting}
                githubCallback={githubCallback}
                onDismissGithubCallback={onDismissGithubCallback}
                onConnect={connectGithubFromOnboarding}
                onManageConnection={manageGithubFromOnboarding}
                onPreviewRepository={repository => setPreview(current => ({ ...current, repository }))}
                onSelectRepository={repository => {
                  // The GitHub result has served its purpose; kept, it would reopen Change on GitHub over a GitLab pick.
                  onDismissGithubCallback();
                  finish({ repository });
                }}
              />
            ) : (
              <OnboardingCodebaseRow repository={draft.repository} index={index('vcs')} {...change('vcs')} />
            )}
          </OnboardingSlot>
          {harnessChoice && (
            <OnboardingSlot>
              {shownStep === 'harness' ? (
                <OnboardingStepCard section="harness" index={index('harness')} note={tk('onboarding.harnessNote')}>
                  <OnboardingHarnessStep
                    label={tk('onboarding.sections.harness')}
                    selected={draft.harness}
                    onSelect={picked => finish({ harness: picked })}
                  />
                </OnboardingStepCard>
              ) : (
                <OnboardingHarnessRow
                  harness={draft.harness ? harness : undefined}
                  index={index('harness')}
                  {...change('harness')}
                />
              )}
            </OnboardingSlot>
          )}
          <OnboardingSlot>
            {shownStep === 'model' ? (
              <OnboardingStepCard
                section="model"
                index={index('model')}
                note={turn ? tk(`onboarding.${TURN_HARNESS_TEXT_KEY[turn]}.description`) : modelDetail}
              >
                {turn ? (
                  <>
                    <OnboardingTurnHarnessStep
                      key={turn}
                      label={tk('onboarding.sections.model')}
                      harness={turn}
                      selected={draft.harnessModel}
                      onPick={harnessModel => updateDraft({ harness: turn, harnessModel })}
                    />
                    {/* Card runs use only sign-ins their owners share with them (9f16f63a66). */}
                    <Txt variant="meta" tone="muted" className="px-3 pb-2">
                      {tk(`onboarding.${TURN_HARNESS_TEXT_KEY[turn]}.factoryRuns`)}
                    </Txt>
                  </>
                ) : (
                  <ModelProviderFactoryStep
                    model={model}
                    onModelChange={modelId => {
                      if (model.connectedProvider && model.connection.method)
                        updateDraft({
                          model: { providerId: model.connectedProvider.provider, method: model.connection.method, modelId },
                        });
                    }}
                    onPreviewModel={previewed => setPreview(current => ({ ...current, model: previewed }))}
                    onPreviewProvider={(providerId, method) =>
                      setPreview(current => ({ ...current, providerId, method, model: undefined }))
                    }
                  />
                )}
              </OnboardingStepCard>
            ) : (
              <OnboardingModelRow
                model={modelTitle}
                detail={modelDetail}
                hint={modelHint}
                index={index('model')}
                {...change('model')}
              />
            )}
          </OnboardingSlot>
          <OnboardingPageAction
            notice={
              <OnboardingCreateNotice
                id={createNoticeId}
                error={complete.error?.message}
                blockedReason={blockedReason}
              />
            }
          >
            <Button
              variant="primary"
              size="lg"
              disabled={complete.isPending || !ready}
              aria-describedby={blockedReason && !complete.error ? createNoticeId : undefined}
              onClick={createFactory}
            >
              {complete.isPending && <Spinner size="sm" aria-label={tk('review.creatingLabel')} />}
              {complete.isPending ? tk('review.creating') : tk('review.create')}
            </Button>
          </OnboardingPageAction>
        </main>
        <Txt as="p" variant="meta" tone="muted" className="mt-auto px-6 pt-2 pb-32 min-[900px]:pb-5">
          {tk('onboarding.changeLater')}
        </Txt>
      </div>
      {/* The page scrolls the form; the preview stays pinned to the viewport beside it. */}
      {showVisual && (
        <div className="sticky top-0 h-dvh p-2">
          <div className="onboarding-card bg-card rounded-studio-frame h-full overflow-hidden p-px">
            <OnboardingPreview
              step={shownStep}
              local={local}
              repository={preview.repository ?? draft.repository}
              model={previewModel}
              providerId={turn ? undefined : (preview.providerId ?? model.connectedProvider?.provider)}
              connectionMethod={turn ? undefined : (preview.method ?? model.connection.method)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
