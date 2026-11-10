import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useFactoryProjectQuery } from '../../../../../hooks/useFactoryDefaultModel';
import { useSetFactoryHarnessMutation } from '../../../../../hooks/useFactoryHarness';
import { translator } from '../../../../i18n/t';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { AGENT_LANGUAGES, isAgentLanguage } from '../../../workspaces/services/github';
import { SettingsSubsection } from '../SettingsSubsection';

const tk = translator('settings');

/**
 * «Мова агентів»: the language every agent of this Factory writes to the team
 * in, on either harness. The server puts it in each session's instructions.
 */
export function AgentLanguageSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const projectQuery = useFactoryProjectQuery(factoryId);
  const mutation = useSetFactoryHarnessMutation(factoryId);
  const current = projectQuery.data?.agentLanguage;
  const language = isAgentLanguage(current) ? current : undefined;

  return (
    <SettingsSubsection
      scope="factory"
      title={t('models.agentLanguage.title')}
      description={t('models.agentLanguage.description')}
    >
      <SettingsContainer>
        <SettingsRow label={t('models.agentLanguage.label')} description={t('models.agentLanguage.note')}>
          {language === undefined ? (
            projectQuery.isError ? (
              <Txt as="span" variant="caption" tone="muted">
                {projectQuery.error instanceof Error ? projectQuery.error.message : t('models.agentLanguage.changeFailed')}
              </Txt>
            ) : (
              <SkeletonRows label={t('models.agentLanguage.title')} rows={1} />
            )
          ) : (
            <Select
              value={language}
              disabled={mutation.isPending}
              onValueChange={next => {
                if (!isAgentLanguage(next) || next === language) return;
                mutation
                  .mutateAsync({ agentLanguage: next })
                  .catch(error =>
                    toast.error(
                      error instanceof Error && error.message ? error.message : tk('models.agentLanguage.changeFailed'),
                    ),
                  );
              }}
            >
              <SelectTrigger size="sm" aria-label={t('models.agentLanguage.label')} className="w-auto">
                <Txt as="span" variant="caption">
                  {t(`models.agentLanguage.languages.${language}`)}
                </Txt>
              </SelectTrigger>
              <SelectContent>
                {AGENT_LANGUAGES.map(option => (
                  <SelectItem key={option} value={option}>
                    {t(`models.agentLanguage.languages.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
