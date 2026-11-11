import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useFactoryQuery } from '../../../../hooks/useFactories';
import {
  useEnvironmentBuildQuery,
  useEnvironmentBuildsQuery,
  useFactoryEnvironmentQuery,
  useRequestEnvironmentBuildMutation,
  useSaveFactoryEnvironmentMutation,
} from '../../../../hooks/useFactoryEnvironment';
import type { FactoryEnvironmentPatch, FactoryEnvironmentPayload } from '../../workspaces/services/environment';
import { settingsSectionPath } from '../settingsSections';
import { BuildHistoryBlock } from './environment/BuildHistoryBlock';
import { BuildStatusBlock } from './environment/BuildStatusBlock';
import { BuildTriggersRows } from './environment/BuildTriggersBlock';
import { RepositoriesBlock } from './environment/RepositoriesBlock';
import type { RepositoryProviders } from './environment/RepositoriesBlock';
import { providerLine, SandboxBlock } from './environment/SandboxBlock';
import { AddSandboxEnvButton, SandboxEnvsBlock } from './environment/SandboxEnvsBlock';
import { WorkspaceSetupBlock } from './environment/WorkspaceSetupBlock';
import { SettingsSubsection } from './SettingsSubsection';

/**
 * The Factory's environment: what every session's sandbox boots from. The
 * repositories it clones, its configuration (workspace setup and the sandbox
 * provider's own settings) and, when the sandbox can build, its builds.
 */
export function EnvironmentSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const environmentQuery = useFactoryEnvironmentQuery(factoryId);
  const factory = factoryQuery.data;
  // The environment payload carries no provider; the factory's link list does.
  const providers: RepositoryProviders = Object.fromEntries(
    (factory?.repositories ?? []).map(repository => [repository.projectRepositoryId, repository.provider ?? 'github']),
  );

  if (!factoryId || (factoryQuery.isSuccess && !factory)) {
    return <Notice variant="info">{t('environment.selectFactory')}</Notice>;
  }

  if (environmentQuery.isError) {
    return (
      <Notice variant="destructive">
        {environmentQuery.error instanceof Error ? environmentQuery.error.message : t('environment.loadFailed')}
      </Notice>
    );
  }
  if (!environmentQuery.data) return <Skeleton className="h-24 w-full" />;

  return (
    <EnvironmentBlocks
      key={factoryId}
      factoryId={factoryId}
      environment={environmentQuery.data}
      providers={providers}
    />
  );
}

function EnvironmentBlocks({
  factoryId,
  environment,
  providers,
}: {
  factoryId: string;
  environment: FactoryEnvironmentPayload;
  providers: RepositoryProviders;
}) {
  const { t } = useTranslation('settings');
  const saveMutation = useSaveFactoryEnvironmentMutation();

  if (environment.repositories.length === 0) {
    return (
      <Notice variant="info">
        {t('environment.linkRepositoryFirst')}{' '}
        <Link to={settingsSectionPath(factoryId, 'repositories')} className="underline">
          {t('environment.goToRepositories')}
        </Link>
      </Notice>
    );
  }

  // Resolves either way: callers fire and forget, the toast carries the failure.
  const save = (input: FactoryEnvironmentPatch) =>
    saveMutation
      .mutateAsync(
        { factoryId, input },
        {
          onSuccess: () => toast.success(t('environment.saved')),
          onError: err => toast.error(err instanceof Error ? err.message : t('environment.saveFailed')),
        },
      )
      .then(
        () => true,
        () => false,
      );

  const disabled = saveMutation.isPending;
  const canBuild = environment.sandbox.capabilities.builds.available && environment.buildTriggers !== undefined;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsSubsection
        scope="factory"
        title={t('environment.repositories.title')}
        description={t('environment.repositories.description')}
      >
        <RepositoriesBlock
          repositories={environment.repositories}
          providers={providers}
          disabled={disabled}
          onSave={save}
        />
      </SettingsSubsection>
      <SettingsSubsection
        scope="factory"
        title={t('environment.configuration.title')}
        description={t('environment.configuration.description', {
          providerLine: providerLine(environment.sandbox.provider),
        })}
      >
        <WorkspaceSetupBlock
          workdir={environment.sandboxWorkingDirectory}
          command={environment.workspaceSetupCommand}
          disabled={disabled}
          onSave={save}
        >
          <SandboxBlock environment={environment} disabled={disabled} onSave={save} />
        </WorkspaceSetupBlock>
      </SettingsSubsection>
      <SettingsSubsection
        scope="factory"
        title={t('sandboxEnvs.title')}
        action={<AddSandboxEnvButton factoryId={factoryId} />}
        description={t('sandboxEnvs.description')}
      >
        <SandboxEnvsBlock factoryId={factoryId} />
      </SettingsSubsection>
      {canBuild && (
        <SettingsSubsection
          scope="factory"
          title={t('environment.builds.title')}
          description={t('environment.builds.description')}
          action={<BuildNow factoryId={factoryId} environment={environment} />}
        >
          <div className="flex flex-col gap-4">
            <SettingsContainer>
              <BuildTriggersRows triggers={environment.buildTriggers!} disabled={disabled} onSave={save} />
            </SettingsContainer>
            {environment.sandbox.capabilities.builds.history && <BuildHistory factoryId={factoryId} />}
          </div>
        </SettingsSubsection>
      )}
    </div>
  );
}

/** Build now with the last build's live status beside it; in the Builds header. */
function BuildNow({ factoryId, environment }: { factoryId: string; environment: FactoryEnvironmentPayload }) {
  const { t } = useTranslation('settings');
  const requestBuild = useRequestEnvironmentBuildMutation();
  const buildQuery = useEnvironmentBuildQuery(factoryId, environment.build?.buildId);

  const buildNow = () =>
    requestBuild.mutate(
      { factoryId },
      {
        onSuccess: started => {
          if (started.outcome === 'started') toast.success(t('environment.builds.started'));
          else toast.error(t('environment.builds.notStarted', { reason: started.reason ?? started.outcome }));
        },
        onError: err => toast.error(err instanceof Error ? err.message : t('environment.builds.startFailed')),
      },
    );

  return (
    <BuildStatusBlock
      lastBuild={environment.build}
      build={buildQuery.data}
      requesting={requestBuild.isPending}
      onBuildNow={buildNow}
    />
  );
}

/** The provider's build history; mounted only when the sandbox lists builds. */
function BuildHistory({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const buildsQuery = useEnvironmentBuildsQuery(factoryId, true);
  return (
    <BuildHistoryBlock
      builds={buildsQuery.data}
      error={
        buildsQuery.isError
          ? buildsQuery.error instanceof Error
            ? buildsQuery.error.message
            : t('environment.builds.loadFailed')
          : undefined
      }
    />
  );
}
