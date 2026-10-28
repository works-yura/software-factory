import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Boxes, GitBranch, Sparkles } from 'lucide-react';
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

function claudeModelTitle(model: OnboardingDraft['claudeCodeModel']) {
  if (model === undefined) return tk('review.chooseModel');
  return tk(`createFactory.claudeCode.models.${model ?? 'default'}.title`);
}

export function OnboardingReviewStep({
  draft,
  local = false,
  harnessChoice = false,
  onEdit,
  onConfirm,
  pending,
  error,
}: {
  draft: OnboardingDraft;
  local?: boolean;
  /** The server runs Claude Code, so the harness is a choice worth showing. */
  harnessChoice?: boolean;
  onEdit: (step: OnboardingStep) => void;
  onConfirm: () => void;
  pending: boolean;
  error?: string;
}) {
  const repo = draft.repository;
  const claude = draft.harness === 'claude-code';
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
        {harnessChoice && (
          <OnboardingReviewRow
            icon={<Boxes />}
            label={tk('review.harness')}
            value={tk(claude ? 'createFactory.harness.claudeCode.title' : 'createFactory.harness.mastra.title')}
            detail={tk('review.harnessDetail')}
            disabled={pending}
            onEdit={() => onEdit('harness')}
          />
        )}
        <OnboardingReviewRow
          icon={<Sparkles />}
          label={tk('review.model')}
          value={claude ? claudeModelTitle(draft.claudeCodeModel) : (draft.model?.modelId ?? tk('review.chooseModel'))}
          detail={claude ? tk('review.claudeModelDetail') : sharedModelDetail(local)}
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
