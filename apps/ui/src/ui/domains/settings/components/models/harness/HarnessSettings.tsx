import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useFactoryProjectQuery } from '../../../../../../hooks/useFactoryDefaultModel';
import { useSetFactoryHarnessMutation } from '../../../../../../hooks/useFactoryHarness';
import { useServerFeatures } from '../../../../../../hooks/useServerFeatures';
import { translator } from '../../../../../i18n/t';
import { SkeletonRows } from '../../../../../ui/SkeletonRows';
import { CLAUDE_CODE_MODELS, isClaudeCodeModel, isFactoryHarness } from '../../../../workspaces/services/github';
import type { ClaudeCodeModel, FactoryHarness } from '../../../../workspaces/services/github';
import { useHarness } from '../../../../../../hooks/useHarness';
import { SettingsSubsection } from '../../SettingsSubsection';

const tk = translator('settings');

/** The `claude --model` choice as a Select value: the CLI default has none. */
const CLI_DEFAULT = 'default';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The harness this Factory's agents start on and its Claude model, read off the
 * Factory project (which a switch updates optimistically). `harness` is
 * undefined until the project loads; a server that predates it means Mastra.
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
  const claudeCodeModel: ClaudeCodeModel | null = isClaudeCodeModel(project?.claudeCodeModel)
    ? project.claudeCodeModel
    : null;
  const descriptor = useHarness(harness);
  return { projectQuery, mutation, harness, descriptor, claudeCodeModel };
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

/** The Claude model this Factory's Claude Code sessions run (`claude --model`). */
export function ClaudeCodeModelSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const { mutation, claudeCodeModel } = useFactoryHarness(factoryId);
  const value = claudeCodeModel ?? CLI_DEFAULT;
  const options = [CLI_DEFAULT, ...CLAUDE_CODE_MODELS] as const;

  return (
    <SettingsSubsection
      scope="factory"
      title={t('models.claudeCode.title')}
      description={t('models.claudeCode.description')}
    >
      <SettingsContainer>
        <SettingsRow label={t('models.claudeCode.modelLabel')} description={t('models.claudeCode.modelDescription')}>
          <Select
            value={value}
            disabled={mutation.isPending}
            onValueChange={next => {
              const model = isClaudeCodeModel(next) ? next : null;
              if (model === claudeCodeModel) return;
              mutation
                .mutateAsync({ claudeCodeModel: model })
                .catch(error => toast.error(errorMessage(error, tk('models.claudeCode.changeFailed'))));
            }}
          >
            <SelectTrigger size="sm" aria-label={t('models.claudeCode.modelLabel')} className="w-auto">
              <Txt as="span" variant="caption">
                {t(`models.claudeCode.models.${value}`)}
              </Txt>
            </SelectTrigger>
            <SelectContent>
              {options.map(option => (
                <SelectItem key={option} value={option}>
                  {t(`models.claudeCode.models.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
