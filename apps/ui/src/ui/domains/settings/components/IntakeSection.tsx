import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { useIncidentioSourcesQuery, useIncidentioStatusQuery } from '../../../../hooks/useIncidentioData';
import { useGitLabProjectsQuery, useGitLabStatusQuery } from '../../../../hooks/useGitLabData';
import {
  useIntakeBindingsQuery,
  useIntakeConfigQuery,
  useSaveIntakeConfigMutation,
} from '../../../../hooks/useIntakeConfig';
import { useJiraProjectsQuery, useJiraStatusQuery } from '../../../../hooks/useJiraData';
import { usePlatformConnectionsQuery } from '../../../../hooks/usePlatformConnections';
import { isPlatformConnectUnavailableError, PLATFORM_CONNECT_PROVIDERS } from '../../factory/services/platformConnect';
import { ProviderConnectControl, ProviderConnectionsList } from './PlatformProviderConnections';
import { useLinearProjectsQuery, useLinearStatusQuery, useLinearTeamsQuery } from '../../../../hooks/useLinearData';
import { isJiraAuthError } from '../../factory/services/jira';
import type { JiraProject, JiraStatus } from '../../factory/services/jira';
import { isGitLabAuthError, isGitLabReauthRequired } from '../../factory/services/gitlab';
import type { GitLabProject, GitLabStatus } from '../../factory/services/gitlab';
import { connectLinear, isLinearReauthError, linearTeamSourceId } from '../../factory/services/linear';
import type { LinearProject, LinearStatus, LinearTeam } from '../../factory/services/linear';
import type { IntakeConfig, IntakeSourceBinding } from '../../factory/services/intake';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import type { FactoryProject, GithubStatus } from '../../workspaces/services/github';
import { SourcePicker } from './IntakeSourcePicker';
import type { SourcePickerGroup } from './IntakeSourcePicker';
import { GithubLabelRouting } from './GithubLabelRouting';
import { IntakeSourceRouting, LinearRouting } from './LinearRouting';

import { SettingsSubsection } from './SettingsSubsection';
import { translator } from '../../../i18n/t';

const tk = translator('settings');

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

const NO_REPOSITORY_MAPPING = '__no_repository_mapping__';

function LinearIntakeSection({
  config,
  busy,
  update,
  status,
  connected,
  projects,
  teams,
  reauthRequired,
  showPickers,
  baseUrl,
  factories,
  bindings,
}: SourceSectionProps & {
  status: LinearStatus | undefined;
  connected: boolean;
  projects: LinearProject[];
  teams: LinearTeam[];
  reauthRequired: boolean;

  showPickers: boolean;
  baseUrl: string;
  factories: FactoryProject[];
  bindings: IntakeSourceBinding[];
}) {
  const { t } = useTranslation('settings');
  const routedProjects = projects.flatMap(project => {
    const sourceIds = config.linear.sourceIds?.includes(project.id)
      ? [project.id]
      : teams
          .filter(team =>
            project.teams.some(
              member => member.id === team.id && config.linear.sourceIds?.includes(linearTeamSourceId(team)),
            ),
          )
          .map(linearTeamSourceId);
    const factoryIds = [
      ...new Set(
        bindings
          .filter(binding => binding.integrationId === 'linear' && sourceIds.includes(binding.sourceId))
          .map(binding => binding.factoryProjectId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (factoryIds.length !== 1) return [];
    const factory = factories.find(candidate => candidate.id === factoryIds[0]);
    const repositorySlugs = [...new Set(factory?.repositories.map(repository => repository.slug) ?? [])];
    return repositorySlugs.length ? [{ project, repositorySlugs }] : [];
  });
  const serverConfigured = status?.enabled !== false;
  const description = !serverConfigured
    ? t('intake.linear.notConfigured')
    : !connected
      ? t('intake.linear.notConnected')
      : reauthRequired
        ? t('intake.linear.reauth')
        : t('intake.linear.ready');

  const action = !serverConfigured ? undefined : !connected ? (
    <Button size="sm" onClick={() => connectLinear(baseUrl)}>
      {t('intake.linear.connect')}
    </Button>
  ) : reauthRequired ? (
    <Button size="sm" onClick={() => connectLinear(baseUrl)}>
      {t('intake.linear.reconnectLinear')}
    </Button>
  ) : (
    <span className="flex items-center gap-2">
      <Txt tone="muted" as="span" variant="caption">
        {status?.workspace?.name
          ? t('intake.connectedTo', { name: status.workspace.name })
          : t('intake.linear.connectedFallback')}
      </Txt>
      <Button size="sm" variant="ghost" onClick={() => connectLinear(baseUrl)}>
        {t('intake.linear.reconnect')}
      </Button>
    </span>
  );

  return (
    <SettingsSubsection scope="org" title={t('intake.linear.title')} description={description} action={action}>
      <SettingsContainer>
        <SettingsRow label={t('intake.linear.sync')}>
          <Switch
            aria-label={t('intake.linear.sync')}
            checked={config.linear.enabled}
            disabled={busy || !connected}
            onCheckedChange={enabled => update({ ...config, linear: { ...config.linear, enabled } })}
          />
        </SettingsRow>

        {showPickers && (
          <SourcePicker
            label={t('intake.linear.sources')}
            groups={groupLinearSourcesByTeam(projects, teams, config.linear.sourceIds)}
            selectedIds={config.linear.sourceIds}
            disabled={busy}
            pending={busy}
            onToggleItem={sourceId =>
              update({
                ...config,
                linear: { ...config.linear, sourceIds: toggleId(config.linear.sourceIds, sourceId) },
              })
            }
          />
        )}

        {routedProjects.length > 0 && (
          <div className="flex flex-col">
            <Txt tone="muted" as="p" variant="caption">
              {t('intake.linear.mapHint')}
            </Txt>
            {routedProjects.map(({ project, repositorySlugs }) => {
              const mappedRepository = config.linear.repositoryByLinearProject?.[project.id];
              return (
                <SettingsRow key={project.id} label={project.name}>
                  <Select
                    value={mappedRepository ?? NO_REPOSITORY_MAPPING}
                    disabled={busy}
                    onValueChange={value => {
                      const repositoryByLinearProject = { ...config.linear.repositoryByLinearProject };
                      if (value === NO_REPOSITORY_MAPPING) delete repositoryByLinearProject[project.id];
                      else repositoryByLinearProject[project.id] = value;
                      update({ ...config, linear: { ...config.linear, repositoryByLinearProject } });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={t('intake.linear.repositoryFor', { name: project.name })} className="w-auto">
                      <Txt as="span" variant="caption">
                        {mappedRepository ?? t('intake.linear.noMapping')}
                      </Txt>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_REPOSITORY_MAPPING}>{t('intake.linear.noMapping')}</SelectItem>
                      {repositorySlugs.map(slug => (
                        <SelectItem key={slug} value={slug}>
                          {slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              );
            })}
          </div>
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function JiraIntakeSection({
  config,
  busy,
  update,
  status,
  projects,
  authError,
  reauthRequired,
  showPickers,
}: SourceSectionProps & {
  status: JiraStatus | undefined;
  projects: JiraProject[];
  authError: boolean;
  reauthRequired: boolean;
  showPickers: boolean;
}) {
  const { t } = useTranslation('settings');
  const configured = Boolean(status?.enabled && status.configured);
  const platformManaged = status?.mode === 'platform' || status?.connections !== undefined;
  const description = reauthRequired
    ? t('intake.jira.reauth')
    : !configured
      ? platformManaged
        ? t('intake.jira.connectPlatform')
        : t('intake.jira.notConfigured')
      : authError
        ? platformManaged
          ? t('intake.jira.rejectedPlatform')
          : t('intake.jira.rejectedCredentials')
        : t('intake.jira.ready');
  const sites = status?.sites ?? (status?.site ? [status.site] : []);
  let connectionLabel = t('intake.jira.connected');
  if (sites.length === 1) {
    connectionLabel = t('intake.connectedTo', { name: sites[0] });
  } else if (sites.length > 1) {
    connectionLabel = t('intake.jira.sites', { count: sites.length });
  } else if (platformManaged) {
    connectionLabel = t('intake.jira.viaPlatform');
  }
  const needsReconnect = reauthRequired || authError;
  const connections = status?.connections ?? [];
  const reconnectTarget =
    needsReconnect && platformManaged
      ? (connections.find(connection => connection.status === 'needs_reauth') ?? connections[0])
      : undefined;
  const actionButton = !platformManaged ? undefined : reconnectTarget ? (
    <ProviderConnectControl
      provider="jira"
      reconnectConnectionId={reconnectTarget.id}
      label={t('intake.jira.reconnect')}
      size="sm"
    />
  ) : (
    <ProviderConnectControl
      provider="jira"
      label={configured ? t('intake.jira.connectAnother') : t('intake.jira.connect')}
      size="sm"
      variant={configured ? 'ghost' : 'default'}
    />
  );
  const action = configured ? (
    <span className="flex items-center gap-2">
      <Txt tone="muted" as="span" variant="caption">
        {connectionLabel}
      </Txt>
      {actionButton}
    </span>
  ) : (
    actionButton
  );

  return (
    <SettingsSubsection scope="org" title={t('intake.jira.title')} description={description} action={action}>
      <SettingsContainer>
        <SettingsRow label={t('intake.jira.sync')}>
          <Switch
            aria-label={t('intake.jira.sync')}
            checked={config.jira.enabled}
            disabled={busy || !configured}
            onCheckedChange={enabled => update({ ...config, jira: { ...config.jira, enabled } })}
          />
        </SettingsRow>

        {platformManaged && connections.length > 1 && (
          <ProviderConnectionsList provider="jira" connections={connections} />
        )}

        {showPickers && (
          <SourcePicker
            label={t('intake.jira.projects')}
            groups={groupJiraProjectsBySite(projects)}
            selectedIds={config.jira.sourceIds}
            disabled={busy}
            pending={busy}
            onToggleItem={projectId =>
              update({
                ...config,
                jira: { ...config.jira, sourceIds: toggleId(config.jira.sourceIds, projectId) },
              })
            }
          />
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function IncidentioIntakeSection({
  config,
  busy,
  update,
  factories,
}: SourceSectionProps & { factories: { id: string; name: string }[] }) {
  const { t } = useTranslation('settings');
  const provider = 'incident-io';
  const meta = PLATFORM_CONNECT_PROVIDERS[provider];
  const connectionsQuery = usePlatformConnectionsQuery(provider);
  const statusQuery = useIncidentioStatusQuery();
  // A deployment-configured API key serves follow-ups without any Platform
  // connection — the section must stay reachable so the org can still select
  // and route sources.
  const directConfigured = Boolean(
    statusQuery.data?.enabled &&
    statusQuery.data.configured &&
    statusQuery.data.mode === 'api-key' &&
    statusQuery.data.reason === 'ready',
  );
  const active = connectionsQuery.data?.filter(connection => connection.status === 'active') ?? [];
  const credentialActive = active.length > 0 || directConfigured;
  const sourcesQuery = useIncidentioSourcesQuery(credentialActive);
  if (connectionsQuery.isPending || statusQuery.isPending) return null;
  if (connectionsQuery.isError && !directConfigured && !isPlatformConnectUnavailableError(connectionsQuery.error)) {
    // A transient failure must keep the section reachable with a retry, or an
    // org with incident.io connected silently loses its sync settings.
    return (
      <SettingsSubsection
        scope="org"
        title={t('intake.incidentio.title')}
        description={t('intake.incidentio.loadFailed')}
        action={
          <Button size="sm" variant="ghost" onClick={() => void connectionsQuery.refetch()}>
            {t('intake.retry')}
          </Button>
        }
      />
    );
  }
  // 403/404 means Platform connections aren't offered here — hide the section
  // unless a deployment API key serves the feature anyway.
  if (connectionsQuery.isError && !directConfigured) return null;
  const connections = connectionsQuery.isError ? [] : connectionsQuery.data;
  const needsReauth = connections.some(connection => connection.status === 'needs_reauth');
  const sources = sourcesQuery.data ?? [];

  // A direct API key takes precedence over Platform connections server-side,
  // so connect controls are only offered when Platform connections drive the
  // integration.
  const action = directConfigured ? (
    <Txt tone="muted" as="span" variant="caption">
      {t('intake.incidentio.apiKeyConfigured')}
    </Txt>
  ) : connections.length === 0 ? (
    <ProviderConnectControl provider={provider} label={t('intake.incidentio.connect', { name: meta.displayName })} />
  ) : (
    <span className="flex items-center gap-2">
      <Txt tone="muted" as="span" variant="caption">
        {active.length === 1
          ? (active[0]?.accountLabel ?? t('intake.incidentio.connected', { name: meta.displayName }))
          : t('intake.incidentio.accounts', { count: active.length, name: meta.displayName })}
      </Txt>
      <ProviderConnectControl provider={provider} label={t('intake.incidentio.connectAnother')} size="sm" variant="ghost" />
    </span>
  );

  const sourceIds = config.incidentio.sourceIds ?? [];
  return (
    <>
      <SettingsSubsection
        scope="org"
        title={t('intake.incidentio.title')}
        description={
          needsReauth && !directConfigured
            ? t('intake.incidentio.reauth')
            : t('intake.incidentio.ready')
        }
        action={action}
      >
        {(connections.length > 0 || directConfigured) && (
          <SettingsContainer>
            <SettingsRow label={t('intake.incidentio.sync')}>
              <Switch
                aria-label={t('intake.incidentio.sync')}
                checked={config.incidentio.enabled}
                disabled={busy || !credentialActive}
                onCheckedChange={enabled => update({ ...config, incidentio: { ...config.incidentio, enabled } })}
              />
            </SettingsRow>
            {!directConfigured && connections.length > 0 && (
              <ProviderConnectionsList provider={provider} connections={connections} />
            )}
            <SettingsRow
              label={t('intake.incidentio.boardConfig')}
              description={t('intake.incidentio.boardConfigDescription')}
            >
              <Badge size="sm" variant="neutral">
                {t('intake.incidentio.comingSoon')}
              </Badge>
            </SettingsRow>
            {config.incidentio.enabled && credentialActive && sourcesQuery.isError && (
              <SettingsRow label={t('intake.incidentio.sources')} description={t('intake.incidentio.sourcesFailed')}>
                <Button size="sm" variant="ghost" onClick={() => void sourcesQuery.refetch()}>
                  {t('intake.retry')}
                </Button>
              </SettingsRow>
            )}
            {config.incidentio.enabled && credentialActive && !sourcesQuery.isError && (
              <SourcePicker
                label={t('intake.incidentio.sources')}
                groups={[
                  {
                    id: 'incidentio-follow-ups',
                    items: sources.map(source => ({ id: source.id, label: source.name })),
                  },
                ]}
                selectedIds={config.incidentio.sourceIds}
                disabled={busy}
                pending={sourcesQuery.isPending || busy}
                onToggleItem={sourceId =>
                  update({
                    ...config,
                    incidentio: {
                      ...config.incidentio,
                      sourceIds: toggleId(config.incidentio.sourceIds, sourceId),
                    },
                  })
                }
              />
            )}
          </SettingsContainer>
        )}
      </SettingsSubsection>
      {config.incidentio.enabled && sourceIds.length > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.incidentio.routingTitle')}
          description={t('intake.incidentio.routingDescription')}
        >
          <SettingsContainer>
            <IntakeSourceRouting
              integrationId="incidentio"
              label="incident.io"
              sourceIds={sourceIds}
              sources={sources}
              factories={factories}
            />
          </SettingsContainer>
        </SettingsSubsection>
      )}
    </>
  );
}

export function IntakeSection() {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const configQuery = useIntakeConfigQuery();
  const saveMutation = useSaveIntakeConfigMutation();
  const factoriesQuery = useFactoriesQuery();
  const bindingsQuery = useIntakeBindingsQuery();
  const githubStatusQuery = useGithubStatusQuery();
  const githubConnected = githubStatusQuery.data?.connected === true;
  const gitlabStatusQuery = useGitLabStatusQuery();
  const gitlabStatus = gitlabStatusQuery.data;
  const gitlabConfigured = Boolean(gitlabStatus?.enabled && gitlabStatus.configured);
  const gitlabProjectsQuery = useGitLabProjectsQuery(gitlabConfigured);
  const linearStatusQuery = useLinearStatusQuery();

  const linearStatus = linearStatusQuery.data;
  const linearConnected = Boolean(linearStatus?.enabled && linearStatus.connected);
  const linearProjectsQuery = useLinearProjectsQuery(linearConnected);
  const linearTeamsQuery = useLinearTeamsQuery(linearConnected);
  const jiraStatusQuery = useJiraStatusQuery();
  const jiraStatus = jiraStatusQuery.data;
  const jiraConfigured = Boolean(jiraStatus?.enabled && jiraStatus.configured);
  const jiraReauthRequired = Boolean(jiraStatus?.connections?.some(connection => connection.status === 'needs_reauth'));
  const jiraProjectsQuery = useJiraProjectsQuery(jiraConfigured);

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
  const linearProjects = linearProjectsQuery.data ?? [];
  const linearTeams = linearTeamsQuery.data ?? [];
  const reauthRequired = isLinearReauthError(linearProjectsQuery.error);
  const routedProjectIds = config.linear.sourceIds ?? [];
  const linearReady =
    linearConnected &&
    config.linear.enabled &&
    !reauthRequired &&
    (linearProjects.length > 0 || linearTeams.length > 0);
  const jiraProjects = jiraProjectsQuery.data ?? [];
  const jiraAuthError = isJiraAuthError(jiraProjectsQuery.error);
  const jiraSourceIds = config.jira.sourceIds ?? [];
  const jiraReady = jiraConfigured && config.jira.enabled && !jiraAuthError && jiraProjects.length > 0;

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
      <LinearIntakeSection
        config={config}
        busy={busy}
        update={update}
        status={linearStatus}
        connected={linearConnected}
        projects={linearProjects}
        teams={linearTeams}
        reauthRequired={reauthRequired}
        showPickers={linearReady}
        baseUrl={baseUrl}
        factories={factoriesQuery.data ?? []}
        bindings={bindingsQuery.data ?? []}
      />
      {linearReady && routedProjectIds.length > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.linear.routingTitle')}
          description={t('intake.linear.routingDescription')}
        >
          <SettingsContainer>
            <LinearRouting
              sourceIds={routedProjectIds}
              projects={linearProjects}
              teams={linearTeams}
              factories={factoriesQuery.data ?? []}
            />
          </SettingsContainer>
        </SettingsSubsection>
      )}
      <JiraIntakeSection
        config={config}
        busy={busy}
        update={update}
        status={jiraStatus}
        projects={jiraProjects}
        authError={jiraAuthError}
        reauthRequired={jiraReauthRequired}
        showPickers={jiraReady}
      />
      {jiraReady && jiraSourceIds.length > 0 && (
        <SettingsSubsection
          scope="org"
          title={t('intake.jira.routingTitle')}
          description={t('intake.jira.routingDescription')}
        >
          <SettingsContainer>
            <IntakeSourceRouting
              integrationId="jira"
              label="Jira"
              sourceIds={jiraSourceIds}
              sources={jiraProjects.map(project => ({ id: project.id, name: `${project.key} · ${project.name}` }))}
              factories={factoriesQuery.data ?? []}
            />
          </SettingsContainer>
        </SettingsSubsection>
      )}
      <IncidentioIntakeSection config={config} busy={busy} update={update} factories={factoriesQuery.data ?? []} />
    </div>
  );
}

/**
 * Group Jira projects by connection (labelled with the site host) so duplicate
 * project keys stay distinguishable — including two connections to the same
 * site, which get numbered labels instead of being merged.
 */
function groupJiraProjectsBySite(projects: JiraProject[]): SourcePickerGroup[] {
  const byConnection = new Map<string, SourcePickerGroup>();
  for (const project of projects) {
    const site = project.site ?? 'Jira';
    const key = project.connectionId ?? site;
    const group = byConnection.get(key) ?? { id: key, label: site, items: [] };
    group.items.push({ id: project.id, label: `${project.key} · ${project.name}` });
    byConnection.set(key, group);
  }
  const groups = [...byConnection.values()].toSorted((left, right) =>
    (left.label ?? '').localeCompare(right.label ?? ''),
  );
  const labelCounts = new Map<string, number>();
  for (const group of groups) labelCounts.set(group.label ?? '', (labelCounts.get(group.label ?? '') ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const group of groups) {
    const label = group.label ?? '';
    if ((labelCounts.get(label) ?? 0) > 1) {
      const ordinal = (seen.get(label) ?? 0) + 1;
      seen.set(label, ordinal);
      group.label = tk('intake.jira.connectionOrdinal', { label, ordinal });
    }
  }
  return groups;
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

function groupLinearSourcesByTeam(
  projects: LinearProject[],
  teams: LinearTeam[],
  selectedIds: string[] | null,
): SourcePickerGroup[] {
  const selected = new Set(selectedIds ?? []);
  const teamById = new Map(teams.map(team => [team.id, team]));
  const byTeam = new Map<string, SourcePickerGroup>();
  const orphans: LinearProject[] = [];

  const ensureGroup = (teamId: string, teamName: string): SourcePickerGroup => {
    const existing = byTeam.get(teamId);
    if (existing) return existing;
    // Only a returned team DTO can mint a selectable team source. Project
    // metadata may arrive first, but it does not carry the backend's opaque id.
    const team = teamById.get(teamId);
    const group: SourcePickerGroup = {
      id: teamId,
      label: teamName,
      items: team ? [{ id: linearTeamSourceId(team), label: tk('intake.linear.allIssuesIn', { team: teamName }) }] : [],
    };
    byTeam.set(teamId, group);
    return group;
  };

  // Seed a group per known team so a team with no projects is still selectable.
  for (const team of teams) ensureGroup(team.id, team.name);

  for (const project of projects) {
    if (project.teams.length === 0) {
      orphans.push(project);
      continue;
    }
    for (const team of project.teams) {
      const group = ensureGroup(team.id, teamById.get(team.id)?.name ?? team.name);
      // A project is redundant when its whole team is already selected.
      const knownTeam = teamById.get(team.id);
      const teamSelected = knownTeam ? selected.has(linearTeamSourceId(knownTeam)) : false;
      const projectSelected = selected.has(project.id);
      group.items.push({
        id: project.id,
        label: project.name,
        ...(teamSelected ? { hint: projectSelected ? tk('intake.linear.projectPrecedence') : tk('intake.linear.includedViaTeam') } : {}),
      });
    }
  }

  const groups = [...byTeam.values()].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
  if (orphans.length) {
    groups.push({
      id: 'no-team',
      label: tk('intake.linear.noTeam'),
      items: orphans.map(project => ({ id: project.id, label: project.name })),
    });
  }
  return groups;
}
