import type { PlanResume } from '@mastra/client-js';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Plan,
  PlanActionGroup,
  PlanBody,
  PlanContent,
  PlanControls,
  PlanCopyButton,
  PlanExpandButton,
  PlanHeader,
  PlanHeaderActions,
  PlanIntro,
  PlanLabel,
  PlanMain,
  PlanPath,
  PlanTitle,
} from '@mastra/playground-ui/components/ai/plan';
import { useTranslation } from 'react-i18next';

import { normalizePlanPath, usePlanFile, useWorkspaceRenderedListing } from '../../../../hooks/use-fs';
import { useThreadWorkspacePath } from '../../workspace-viewer/hooks/useThreadWorkspacePath';
import { parsePlanMarkdown, resolveInlinePlan } from './submit-plan-source';
import { Txt } from '@mastra/playground-ui/components/Txt';

/**
 * The `submit_plan` approval and history card.
 *
 * Content resolution lives in `submit-plan-source.ts`; this card fetches the
 * plan file from the session workspace when the call carries no inline plan,
 * and on approve/reject back-fills `path`/`title`/`plan` into the resume data
 * so the persisted tool result replays the plan durably even after the plan
 * file changes or disappears.
 */

export interface SubmitPlanCardProps {
  toolCallId: string;
  input?: unknown;
  output?: unknown;
  isSubmitting?: boolean;
  onRespond?: (response: PlanResume) => void;
}

export function SubmitPlanCard({ toolCallId, input, output, isSubmitting = false, onRespond }: SubmitPlanCardProps) {
  const { t } = useTranslation('chat');
  const inline = resolveInlinePlan(input, output);
  const path = inline.path;

  const workspace = useThreadWorkspacePath();
  // Absolute artifact paths must be normalized against the authoritative
  // workspace `.artifacts` root before the file route (which requires a
  // workspace-relative path) will serve them.
  const needsRoot = inline.plan === undefined && Boolean(path?.startsWith('/'));
  const rendered = useWorkspaceRenderedListing(workspace.workspacePath, '.artifacts', { enabled: needsRoot });
  const readablePath = normalizePlanPath(path, rendered.data?.rootPath);
  const fetchable = inline.plan === undefined && readablePath !== undefined;
  const file = usePlanFile(workspace.workspacePath, readablePath, toolCallId, { enabled: fetchable });
  const fetched = fetchable && file.data?.content !== undefined ? parsePlanMarkdown(file.data.content) : undefined;

  // `title` is persisted into the resume data, so its fallback stays English; only the display is translated.
  const title = inline.title ?? fetched?.title ?? 'Plan';
  const displayTitle = inline.title ?? fetched?.title ?? t('plan.title');
  const plan = inline.plan ?? fetched?.plan ?? '';
  const loading =
    inline.plan === undefined &&
    !fetched &&
    !file.isError &&
    !rendered.isError &&
    (workspace.isPending ||
      (needsRoot && Boolean(workspace.workspacePath) && rendered.isPending) ||
      (fetchable && Boolean(workspace.workspacePath) && file.isPending));
  const unavailable = inline.plan === undefined && !fetched && !loading;
  // Responding while the plan is still loading would back-fill an empty plan
  // into the durable result — hold responses until the fetch settles.
  const respondDisabled = isSubmitting || loading;
  // Never approve a plan with no visible body (missing, blank, loading, or
  // submitting). Reject stays available after a load failure.
  const approveDisabled = respondDisabled || plan.trim().length === 0;

  const respond = (response: PlanResume) =>
    onRespond?.({
      ...response,
      ...(path ? { path } : {}),
      ...(plan ? { plan } : {}),
      ...(title !== 'Plan' || plan ? { title } : {}),
    });

  return (
    <Plan role="group" aria-label={t('plan.approval')}>
      <PlanHeader>
        <PlanLabel />
        <PlanHeaderActions>
          <PlanCopyButton content={plan} disabled={plan.length === 0} />
        </PlanHeaderActions>
      </PlanHeader>
      <PlanBody>
        <PlanIntro>
          <PlanTitle>{displayTitle}</PlanTitle>
          {path ? <PlanPath>{path}</PlanPath> : null}
        </PlanIntro>
        <PlanMain>
          {loading ? (
            <Txt variant="caption" tone="muted" aria-label={t('plan.loadingLabel')} className="my-2">
              {t('plan.loading')}
            </Txt>
          ) : unavailable ? (
            <Txt variant="caption" tone="muted" role="note" className="my-2">
              {path ? t('plan.unavailableAt', { path }) : t('plan.unavailable')}
            </Txt>
          ) : (
            <PlanContent>{plan}</PlanContent>
          )}
          {inline.feedback ? (
            <div role="note" aria-label={t('plan.feedbackLabel')} className="border-badge-green-indicator mt-4 border-l-2 pl-3">
              <Txt variant="meta" tone="muted" className="mb-1">
                {t('plan.feedback')}
              </Txt>
              <Txt variant="caption" tone="ink" className="whitespace-pre-wrap">
                {inline.feedback}
              </Txt>
            </div>
          ) : null}
          {onRespond ? (
            <PlanControls>
              <>
                <PlanActionGroup>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    className="whitespace-nowrap"
                    aria-label={t('plan.approveLabel')}
                    disabled={approveDisabled}
                    onClick={() => respond({ action: 'approved' })}
                  >
                    {t('plan.approve')}
                  </Button>
                </PlanActionGroup>
                <span className="flex justify-center">
                  <PlanExpandButton />
                </span>
                <PlanActionGroup>
                  <Button
                    type="button"
                    size="sm"
                    className="whitespace-nowrap"
                    aria-label={t('plan.rejectLabel')}
                    disabled={respondDisabled}
                    onClick={() => respond({ action: 'rejected' })}
                  >
                    {t('plan.reject')}
                  </Button>
                </PlanActionGroup>
              </>
            </PlanControls>
          ) : (
            // Resolved cards keep the expand control; it hides itself when the collapsed body is not clipped.
            <PlanControls />
          )}
        </PlanMain>
      </PlanBody>
    </Plan>
  );
}
