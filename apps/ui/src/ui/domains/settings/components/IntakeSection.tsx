import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useGitLabProjectsQuery, useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import { useIntakeConfigQuery, useSaveIntakeConfigMutation } from '../../../../hooks/useIntakeConfig';
import { isGitLabAuthError, isGitLabReauthRequired } from '../../factory/services/gitlab';
import type { GitLabProject, GitLabStatus } from '../../factory/services/gitlab';
import type { IntakeConfig } from '../../factory/services/intake';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import type { GithubStatus } from '../../workspaces/services/github';
import { SourcePicker } from './IntakeSourcePicker';
import type { SourcePickerGroup } from './IntakeSourcePicker';
import { GithubLabelRouting } from './GithubLabelRouting';
import { IntakeSourceRouting } from './LinearRouting';

import { SettingsSubsection } from './SettingsSubsection';

function toggleId(ids: string[] | null, id: string): string[] | null {
  const current = ids ?? [];
  const next = current.includes(id) ? current.filter(v => v !== id) : [...current, id];
  return next.length ? next : null;
}

interface SourceSectionProps {
  config: IntakeConfig;
  busy: boolean;
  update: (next: IntakeConfig) => void;
}

function GithubIntakeSection({
  config,
  busy,
  update,
  slugs,
  status,
  statusPending,
  statusRefetching,
  onRetryStatus,
}: SourceSectionProps & {
  slugs: string[];
  status: GithubStatus | undefined;
  statusPending: boolean;
  statusRefetching: boolean;
  onRetryStatus: () => void;
}) {
  const { t } = useTranslation('settings');
  const connected = status?.connected === true;
  // 'unavailable' is set by the browser when the status request failed, not
  // by the server, so it must not read as "not configured".
  const statusUnavailable = status?.reason === 'unavailable';
  const description = statusPending
    ? t('intake.github.checking')
    : statusUnavailable
      ? t('intake.github.statusUnavailable')
      : status?.reason === 'auth_required'
        ? t('intake.github.authRequired')
        : status?.reason === 'organization_required'
          ? t('intake.github.organizationRequired')
          : status?.enabled !== true
            ? t('intake.github.notConfigured')
            : !connected
              ? t('intake.github.notConnected')
              : t('intake.github.ready');
  const action = statusUnavailable ? (
    <Button size="sm" variant="ghost" disabled={statusRefetching} onClick={onRetryStatus}>
      {t('intake.retry')}
    </Button>
  ) : undefined;

  return (
    <SettingsSubsection scope="org" title={t('intake.github.title')} description={description} action={action}>
      <SettingsContainer>
        <SettingsRow label={t('intake.github.sync')}>
          <Switch
            aria-label={t('intake.github.sync')}
            checked={config.github.enabled}
            disabled={busy || !connected}
            onCheckedChange={enabled => update({ ...config, github: { ...config.github, enabled } })}
          />
        </SettingsRow>

        {connected &&
          config.github.enabled &&
          (slugs.length === 0 ? (
            <Txt tone="muted" as="p" variant="caption" className="px-4 py-3">
              {t('intake.github.noRepositories')}
            </Txt>
          ) : (
            <SourcePicker
              label={t('intake.github.repositories')}
              groups={[
                {
                  id: 'repositories',
                  items: slugs.map(slug => ({ id: slug, label: slug })),
                },
              ]}
              selectedIds={config.github.sourceIds}
              disabled={busy}
              pending={busy}
              onToggleItem={slug =>
                update({
                  ...config,
                  github: { ...config.github, sourceIds: toggleId(config.github.sourceIds, slug) },
                })
              }
            />
          ))}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function GitLabIntakeSection({
  config,
  busy,
  update,
  status,
  projects,
  authError,
  reauthRequired,
  showPickers,
}: SourceSectionProps & {
  status: GitLabStatus | undefined;
  projects: GitLabProject[];
  authError: boolean;
  reauthRequired: boolean;
  showPickers: boolean;
}) {
  const { t } = useTranslation('settings');
  const configured = Boolean(status?.enabled && status.configured);
  const platformManaged = status?.connections !== undefined;
  const description = reauthRequired
    ? t('intake.gitlab.reauth')
    : !configured
      ? platformManaged
        ? t('intake.gitlab.connectPlatform')
        : t('intake.gitlab.notConfigured')
      : authError
        ? platformManaged
          ? t('intake.gitlab.rejectedPlatform')
          : t('intake.gitlab.rejectedToken')
        : t('intake.gitlab.ready');
  const accounts = status?.accounts ?? [];
  const action = configured ? (
    <Txt tone="muted" as="span" variant="caption">
      {accounts.length === 1
        ? t('intake.connectedTo', { name: accounts[0] })
        : t('intake.gitlab.accounts', { count: accounts.length })}
    </Txt>
  ) : undefined;

  return (
    <SettingsSubsection scope="org" title={t('intake.gitlab.title')} description={description} action={action}>
      <SettingsContainer>
        <SettingsRow label={t('intake.gitlab.sync')}>
          <Switch
            aria-label={t('intake.gitlab.sync')}
            checked={config.gitlab.enabled}
            disabled={busy || !configured}
            onCheckedChange={enabled => update({ ...config, gitlab: { ...config.gitlab, enabled } })}
          />
        </SettingsRow>

        {showPickers && (
          <SourcePicker
            label={t('intake.gitlab.projects')}
            groups={groupGitLabProjectsByAccount(projects)}
            selectedIds={config.gitlab.sourceIds}
            disabled={busy}
            pending={busy}
            onToggleItem={projectId =>
              update({
                ...config,
                gitlab: { ...config.gitlab, sourceIds: toggleId(config.gitlab.sourceIds, projectId) },
              })
            }
          />
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

export function IntakeSection() {
  const { t } = useTranslation('settings');
  const configQuery = useIntakeConfigQuery();
  const saveMutation = useSaveIntakeConfigMutation();
  const factoriesQuery = useFactoriesQuery();
  const githubStatusQuery = useGithubStatusQuery();
  const githubConnected = githubStatusQuery.data?.connected === true;
  const gitlabStatusQuery = useGitLabStatusQuery();
  const gitlabStatus = gitlabStatusQuery.data;
  const gitlabConfigured = Boolean(gitlabStatus?.enabled && gitlabStatus.configured);
  const gitlabProjectsQuery = useGitLabProjectsQuery(gitlabConfigured);

  const config = configQuery.data;

  const linkedSlugs = [
    ...new Set(
      (factoriesQuery.data ?? []).flatMap(factory =>
        factory.repositories.filter(repository => repository.provider !== 'gitlab').map(repository => repository.slug),
      ),
    ),
  ];

  if (configQuery.isPending) {
    return <SkeletonRows label={t('intake.loading')} rows={4} />;
  }
  if (configQuery.isError || !config) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('intake.unavailable')}
      </Txt>
    );
  }

  const update = (next: IntakeConfig) => {
    saveMutation.mutate(next, {
      onSuccess: () => toast.success(t('intake.saved')),
      onError: err => toast.error(err instanceof Error ? err.message : t('intake.saveFailed')),
    });
  };
  const busy = saveMutation.isPending;
  const gitlabProjects = gitlabProjectsQuery.data ?? [];
  const gitlabAuthError = isGitLabAuthError(gitlabProjectsQuery.error);
  const gitlabReauthRequired = isGitLabReauthRequired(gitlabStatus);
  const gitlabSourceIds = config.gitlab.sourceIds ?? [];
  const gitlabReady = gitlabConfigured && config.gitlab.enabled && !gitlabAuthError && gitlabProjects.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <GithubIntakeSection
        config={config}
        busy={busy}
        update={update}
        slugs={linkedSlugs}
        status={githubStatusQuery.data}
        statusPending={githubStatusQuery.isPending}
        statusRefetching={githubStatusQuery.isFetching}
        onRetryStatus={() => void githubStatusQuery.refetch()}
      />
      {githubConnected && config.github.enabled && linkedSlugs.length > 0 && (factoriesQuery.data?.length ?? 0) > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.github.routingTitle')}
          description={t('intake.github.routingDescription')}
        >
          {(factoriesQuery.data ?? [])
            .filter(factory => factory.repositories.some(repository => repository.provider !== 'gitlab'))
            .map(factory => (
              <SettingsContainer key={factory.id}>
                <GithubLabelRouting
                  factoryProjectId={factory.id}
                  name={factory.name}
                  repositories={factory.repositories
                    .filter(repository => repository.provider !== 'gitlab')
                    .map(repository => repository.slug)}
                />
              </SettingsContainer>
            ))}
        </SettingsSubsection>
      )}
      <GitLabIntakeSection
        config={config}
        busy={busy}
        update={update}
        status={gitlabStatus}
        projects={gitlabProjects}
        authError={gitlabAuthError}
        reauthRequired={gitlabReauthRequired}
        showPickers={gitlabReady}
      />
      {gitlabReady && gitlabSourceIds.length > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.gitlab.routingTitle')}
          description={t('intake.gitlab.routingDescription')}
        >
          <SettingsContainer>
            <IntakeSourceRouting
              integrationId="gitlab"
              label="GitLab"
              sourceIds={gitlabSourceIds}
              sources={gitlabProjects}
              factories={factoriesQuery.data ?? []}
            />
          </SettingsContainer>
        </SettingsSubsection>
      )}
    </div>
  );
}

/** Group GitLab projects by connected account so same-named projects remain distinguishable. */
function groupGitLabProjectsByAccount(projects: GitLabProject[]): SourcePickerGroup[] {
  const byAccount = new Map<string, SourcePickerGroup>();
  for (const project of projects) {
    const account = project.accountLabel ?? 'GitLab';
    const group = byAccount.get(account) ?? { id: project.connectionId ?? account, label: account, items: [] };
    group.items.push({ id: project.id, label: project.name });
    byAccount.set(account, group);
  }
  return [...byAccount.values()].toSorted((left, right) => (left.label ?? '').localeCompare(right.label ?? ''));
}
