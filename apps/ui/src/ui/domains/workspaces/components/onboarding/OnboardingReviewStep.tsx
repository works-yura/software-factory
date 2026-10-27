import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { GitBranch, Sparkles } from 'lucide-react';
import { isGitLabRepository } from '../../services/github';
import { completeOnboardingSchema } from '../../services/onboardingFlow';
import type { OnboardingDraft, OnboardingStep } from '../../services/onboardingFlow';

import { OnboardingReviewRow } from './OnboardingReviewRow';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

function sharedModelDetail(local: boolean) {
  if (local) return tk('review.sharedModel.local');
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
        <OnboardingReviewRow
          icon={<Sparkles />}
          label={tk('review.model')}
          value={draft.model?.modelId ?? tk('review.chooseModel')}
          detail={sharedModelDetail(local)}
          disabled={pending}
          onEdit={() => onEdit('model-provider')}
        />
      </div>
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
