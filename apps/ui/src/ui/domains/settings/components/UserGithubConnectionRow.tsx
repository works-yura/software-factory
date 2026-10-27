import { Button } from '@mastra/playground-ui/components/Button';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { connectUserGithub } from '../../workspaces/services/github';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';

export function UserGithubConnectionRow() {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const status = useGithubStatusQuery().data;

  if (!status || status.installations.length === 0) return undefined;

  if (status.userConnected) {
    return (
      <SettingsSubsection scope="personal" title={t('account.github.title')}>
        <SettingsContainer>
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                <GithubIcon className="text-muted-foreground size-4 shrink-0" />
                {`@${status.userGithubUsername ?? t('account.github.unknown')}`}
              </span>
            }
            description={t('account.github.connectedDescription')}
          />
        </SettingsContainer>
      </SettingsSubsection>
    );
  }

  if (status.userConnected !== false) return undefined;

  return (
    <SettingsSubsection scope="personal" title={t('account.github.title')}>
      <SettingsContainer>
        <SettingsRow label={t('account.github.notConnected')}
          description={t('account.github.notConnectedDescription')}
        >
          <Button size="sm" onClick={() => connectUserGithub(baseUrl)}>
            <GithubIcon className="size-3.5" />
            {t('account.github.connect')}
          </Button>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
