import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Boxes, GitBranch, Sparkles } from 'lucide-react';
import { isGitLabRepository } from '../../services/github';
import { completeOnboardingSchema } from '../../services/onboardingFlow';
import type { OnboardingDraft, OnboardingStep } from '../../services/onboardingFlow';
import { isTurnHarness } from '../../services/turnHarness';
import type { TurnHarness } from '../../services/turnHarness';

import { OnboardingReviewRow } from './OnboardingReviewRow';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

function sharedModelDetail(local: boolean) {
  if (local) return tk('review.sharedModel.local');
  return tk('review.sharedModel.factory');
}

/** How the review names a turn-based harness's model: Claude's alias by its title, Codex's slug as it is. */
export function turnHarnessModelTitle(harness: TurnHarness, model: OnboardingDraft['harnessModel']) {
  if (model === undefined) return tk('review.chooseModel');
  if (harness === 'codex') return model ?? tk('createFactory.codex.models.default.title');
  return tk(`createFactory.claudeCode.models.${model ?? 'default'}.title`);
}

const HARNESS_TITLE: Record<string, string> = {
  'claude-code': 'createFactory.harness.claudeCode.title',
  codex: 'createFactory.harness.codex.title',
};

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
  const turn = isTurnHarness(draft.harness) ? draft.harness : undefined;
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
            value={tk(turn ? HARNESS_TITLE[turn]! : 'createFactory.harness.mastra.title')}
            detail={tk('review.harnessDetail')}
            disabled={pending}
            onEdit={() => onEdit('harness')}
          />
        )}
        <OnboardingReviewRow
          icon={<Sparkles />}
          label={tk('review.model')}
          value={turn ? turnHarnessModelTitle(turn, draft.harnessModel) : (draft.model?.modelId ?? tk('review.chooseModel'))}
          detail={turn ? tk(turn === 'codex' ? 'review.codexModelDetail' : 'review.claudeModelDetail') : sharedModelDetail(local)}
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
