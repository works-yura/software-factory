import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useFactoryProjectQuery } from '../../../../../../hooks/useFactoryDefaultModel';
import { useSetFactoryHarnessMutation } from '../../../../../../hooks/useFactoryHarness';
import { useServerFeatures } from '../../../../../../hooks/useServerFeatures';
import { translator } from '../../../../../i18n/t';
import { SkeletonRows } from '../../../../../ui/SkeletonRows';
import { isFactoryHarness } from '../../../../workspaces/services/github';
import type { FactoryHarness } from '../../../../workspaces/services/github';
import { useHarness } from '../../../../../../hooks/useHarness';
import { SettingsSubsection } from '../../SettingsSubsection';

const tk = translator('settings');

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The harness this Factory's agents start on, read off the Factory project (which a
 * switch updates optimistically). `harness` is undefined until the project loads; a
 * server that predates it means Mastra.
 */
export function useFactoryHarness(factoryId: string) {
  const projectQuery = useFactoryProjectQuery(factoryId);
  const mutation = useSetFactoryHarnessMutation(factoryId);
  const project = projectQuery.data;
  const harness: FactoryHarness | undefined = project
    ? isFactoryHarness(project.harness)
      ? project.harness
      : 'mastra'
    : undefined;
  const descriptor = useHarness(harness);
  return { projectQuery, mutation, harness, descriptor };
}

/**
 * Switch between Mastra and Claude Code. Only new sessions follow: a card
 * already running finishes on the harness it started on.
 */
export function HarnessSwitchSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const features = useServerFeatures();
  const { projectQuery, mutation, harness } = useFactoryHarness(factoryId);
  const claudeAvailable = features.data?.claudeCode === true;

  return (
    <SettingsSubsection scope="factory" title={t('models.harness.title')} description={t('models.harness.description')}>
      <SettingsContainer>
        <SettingsRow label={t('models.harness.label')} description={t('models.harness.note')}>
          {harness === undefined ? (
            projectQuery.isError ? (
              <Txt as="span" variant="caption" tone="muted">
                {errorMessage(projectQuery.error, t('models.harness.changeFailed'))}
              </Txt>
            ) : (
              <SkeletonRows label={t('models.harness.title')} rows={1} />
            )
          ) : (
            <div className="flex flex-col items-end gap-1">
              <SegmentedControl
                aria-label={t('models.harness.label')}
                size="sm"
                value={harness}
                disabled={mutation.isPending}
                onValueChange={next => {
                  if (next === harness) return;
                  mutation
                    .mutateAsync({ harness: next })
                    .catch(error => toast.error(errorMessage(error, tk('models.harness.changeFailed'))));
                }}
              >
                <SegmentedControlItem value="mastra">{t('models.harness.mastra')}</SegmentedControlItem>
                {/* A Factory already on Claude Code keeps the option even where the server lost it. */}
                <SegmentedControlItem value="claude-code" disabled={!claudeAvailable && harness !== 'claude-code'}>
                  {t('models.harness.claudeCode')}
                </SegmentedControlItem>
              </SegmentedControl>
              {features.data && !claudeAvailable && (
                <Txt as="span" variant="caption" tone="muted">
                  {t('models.harness.claudeUnavailable')}
                </Txt>
              )}
            </div>
          )}
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
