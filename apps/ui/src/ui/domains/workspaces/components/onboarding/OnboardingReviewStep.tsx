import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Building2, GitBranch, Sparkles, UserRound } from 'lucide-react';
import { CONNECTION_METHOD_LABEL } from '../../hooks/useProviderConnection';
import { SETUP_LABELS } from '../../services/onboardingSteps';
import { isGitLabRepository } from '../../services/github';
import { completeOnboardingSchema } from '../../services/onboardingFlow';
import type { OnboardingDraft, OnboardingModelScope, OnboardingStep } from '../../services/onboardingFlow';

import { OnboardingReviewRow } from './OnboardingReviewRow';
import { OnboardingWorkReviewRow } from './OnboardingWorkReviewRow';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

function sharedModelDetail(scope: OnboardingModelScope | undefined, local: boolean) {
  if (local) return tk('review.sharedModel.local');
  if (scope === 'hybrid') return tk('review.sharedModel.hybrid');
  return tk('review.sharedModel.factory');
}

export function OnboardingReviewStep({
  draft,
  local = false,
  onEdit,
  onConfirm,
  pending,
  error,
}: {
  draft: OnboardingDraft;
  local?: boolean;
  onEdit: (step: OnboardingStep) => void;
  onConfirm: () => void;
  pending: boolean;
  error?: string;
}) {
  const repo = draft.repository;
  const personal = draft.personal;
  const personalMethod = personal && CONNECTION_METHOD_LABEL[personal.method];
  const shared = draft.modelScope !== 'user';
  const readyToCreate = completeOnboardingSchema.safeParse(draft).success;
  return (
    <section aria-label={tk('review.label')} className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:gap-4">
        <OnboardingReviewRow
          icon={<GitBranch />}
          label={tk('review.codebase')}
          value={repo?.fullName ?? tk('vcs.chooseRepository')}
          detail={repo ? `${isGitLabRepository(repo) ? 'GitLab' : 'GitHub'} · ${repo.defaultBranch}` : undefined}
          disabled={pending}
          onEdit={() => onEdit('vcs')}
        />
        <OnboardingWorkReviewRow disabled={pending} onEdit={() => onEdit('project-management')} />
        {!local && (
          <OnboardingReviewRow
            icon={<Building2 />}
            label={tk('review.setup')}
            value={draft.modelScope ? SETUP_LABELS[draft.modelScope] : tk('review.chooseSetup')}
            detail={tk('review.setupDetail')}
            disabled={pending}
            onEdit={() => onEdit('model-setup')}
          />
        )}
        {shared ? (
          <OnboardingReviewRow
            icon={<Sparkles />}
            label={tk('review.model')}
            value={draft.model?.modelId ?? tk('review.chooseModel')}
            detail={sharedModelDetail(draft.modelScope, local)}
            disabled={pending}
            onEdit={() => onEdit('model-provider')}
          />
        ) : (
          <OnboardingReviewRow
            icon={<Sparkles />}
            label={tk('review.model')}
            value={personal?.modelId ?? tk('review.chooseModel')}
            detail={personal && tk('review.personalDefaultAll', { method: personalMethod })}
            disabled={pending}
            onEdit={() => onEdit('personal-provider')}
          />
        )}
        {draft.modelScope === 'hybrid' && (
          <OnboardingReviewRow
            icon={<UserRound />}
            label={tk('review.personalModel')}
            value={personal?.modelId ?? tk('review.chooseSessionModel')}
            detail={personal ? tk('review.personalDefaultSessions', { method: personalMethod }) : undefined}
            disabled={pending}
            onEdit={() => onEdit('personal-provider')}
          />
        )}
      </div>
      {draft.modelScope !== 'factory' && (
        <Txt variant="meta" tone="muted">
          {tk('review.personalDefaultNote')}
        </Txt>
      )}
      {error && (
        <Txt variant="caption" role="alert">
          {error}
        </Txt>
      )}
      <div>
        <Button variant="primary" size="lg" disabled={pending || !readyToCreate} onClick={onConfirm}>
          {pending && <Spinner size="sm" aria-label={tk('review.creatingLabel')} />}
          {pending ? tk('review.creating') : tk('review.create')}
        </Button>
      </div>
    </section>
  );
}
