import { Txt } from '@mastra/playground-ui/components/Txt';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { ChevronRight, InfoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { SlackIcon } from '@mastra/playground-ui/icons/SlackIcon';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useApiConfig } from '../../../../api/config';
import { useChannelAccountsQuery } from '../../../../hooks/useChannelAccounts';
import { connectSlackUrl } from '../services/channelAccounts';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

// Env vars alone do not prove the deployment registers SlackIntegration.
export function SlackNotConfigured() {
  const { t } = useTranslation('settings');
  return (
    <SettingsContainer>
      <SettingsRow
        label={
          <span className="flex items-center gap-3">
            <SlackIcon className="size-7 shrink-0 opacity-50" />
            <span className="flex flex-col gap-0.5">
              <Txt as="span" variant="body">
                Slack
              </Txt>
              <Txt tone="muted" as="span" variant="caption" className="whitespace-nowrap">
                {t('connectedAccounts.slack.notConfigured')}
              </Txt>
            </span>
          </span>
        }
      >
        <Txt
          tone="muted"
          as="span"
          variant="caption"
          className="flex items-start gap-1.5 pl-10 text-left lg:block lg:pl-0 lg:text-right"
        >
          <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 lg:hidden" />
          {t('connectedAccounts.slack.notSetUp')}
        </Txt>
      </SettingsRow>
    </SettingsContainer>
  );
}

export function ConnectedAccountsSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const { baseUrl } = useApiConfig();
  const accountsQuery = useChannelAccountsQuery();
  const slackAccounts = accountsQuery.data?.accounts.filter(account => account.platform === 'slack') ?? [];
  const canConnect = accountsQuery.data?.canConnect ?? false;

  const connectSlack = () => {
    window.location.assign(connectSlackUrl(baseUrl, factoryId));
  };

  if (accountsQuery.isPending) {
    return <SkeletonRows label={t('connectedAccounts.loading')} rows={1} rowClassName="h-16 w-full" />;
  }

  if (accountsQuery.error) {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground">
        {accountsQuery.error instanceof Error ? accountsQuery.error.message : t('connectedAccounts.loadFailed')}
      </Txt>
    );
  }

  if (accountsQuery.data?.reason === 'not_registered' || accountsQuery.data?.unavailable) {
    return <SlackNotConfigured />;
  }

  const slackLabel = (
    <span className="flex items-center gap-3">
      <SlackIcon className="size-7 shrink-0" />
      <span className="flex flex-col gap-0.5">
        <Txt as="span" variant="body">
          Slack
        </Txt>
        <Txt
          tone="muted"
          as="span"
          variant="caption"
          className={slackAccounts.length > 0 ? 'text-success-indicator' : ''}
        >
          {slackAccounts.length > 1
            ? t('connectedAccounts.slack.connectedCount', { count: slackAccounts.length })
            : slackAccounts.length === 1
              ? t('connectedAccounts.slack.connected')
              : t('connectedAccounts.slack.notConnected')}
        </Txt>
      </span>
    </span>
  );

  return (
    <SettingsContainer>
      {slackAccounts.length > 0 && factoryId ? (
        <Link
          to={`/factories/${factoryId}/settings/connections/slack`}
          className={`group hover:bg-fill block cursor-pointer rounded-xl transition-colors ${focusRing}`}
        >
          <SettingsRow label={slackLabel}>
            <Txt
              as="span"
              variant="caption"
              tone="muted"
              className="group-hover:text-foreground flex items-center gap-2"
            >
              {t('connectedAccounts.slack.configure')}
              <ChevronRight aria-hidden="true" />
            </Txt>
          </SettingsRow>
        </Link>
      ) : (
        <button
          type="button"
          disabled={!canConnect}
          onClick={connectSlack}
          className={`group hover:bg-fill block w-full cursor-pointer rounded-xl text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
        >
          <SettingsRow label={slackLabel}>
            <Txt
              as="span"
              variant="caption"
              tone="muted"
              className="group-hover:text-foreground flex items-center gap-2"
            >
              {t('connectedAccounts.connect')}
              <ChevronRight aria-hidden="true" />
            </Txt>
          </SettingsRow>
        </button>
      )}
    </SettingsContainer>
  );
}
