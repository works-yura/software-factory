import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';

import { useJiraProjectsQuery, useJiraStatusQuery } from '../../../../../hooks/useJiraData';
import {
  useConnectPlatformProviderMutation,
  usePlatformConnectionsQuery,
  useReconnectPlatformProviderMutation,
} from '../../../../../hooks/usePlatformConnections';
import { isJiraAuthError } from '../../../factory/services/jira';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { JiraIcon } from '../../../../ui/icons';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryJiraRowsProps {
  query: string;
  onSelectProject: (projectId: string) => void;
}

export function CreateFactoryJiraRows({ query, onSelectProject }: CreateFactoryJiraRowsProps) {
  const jiraStatus = useJiraStatusQuery();
  const status = jiraStatus.data;
  const connected = status?.configured === true;
  const projects = useJiraProjectsQuery(connected);
  const connections = usePlatformConnectionsQuery('jira', status?.mode === 'platform');
  const connect = useConnectPlatformProviderMutation('jira');
  const reconnect = useReconnectPlatformProviderMutation('jira');
  const reauthConnection = status?.connections?.find(connection => connection.status === 'needs_reauth');
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (title: string) => title.toLowerCase().includes(normalizedQuery);
  const pending = connect.isPending || reconnect.isPending;
  const connectTitle = reauthConnection ? tk('createFactory.jira.reconnect') : tk('vcs.connect', { host: 'Jira' });
  const connectError = reconnect.error ?? connect.error;

  const runConnect = () => {
    if (reauthConnection) {
      reconnect.mutate({ connectionId: reauthConnection.id });
      return;
    }
    connect.mutate({});
  };

  if (jiraStatus.isPending || (connected && projects.isPending)) {
    return <SkeletonRows label={tk('createFactory.jira.loading')} rows={2} rowClassName="mx-2 my-1 h-12 rounded-xl" />;
  }

  if (!connected) {
    const connectable = status?.mode === 'platform' && connections.isSuccess;
    if (!connectable && status?.reason === 'missing_config') return null;
    return (
      <CommandGroup heading="Jira">
        {connectError && <CreateFactoryPaletteAlert>{connectError.message}</CreateFactoryPaletteAlert>}
        {connectable && matches(connectTitle) ? (
          <CommandPaletteItem
            icon={<JiraIcon />}
            title={pending ? tk('createFactory.jira.connecting') : connectTitle}
            subtitle={tk('createFactory.jira.connectHint')}
            value="connect-jira"
            disabled={pending}
            onSelect={runConnect}
          />
        ) : (
          !connectable && (
            <CreateFactoryPaletteMessage>{tk('createFactory.jira.unavailable')}</CreateFactoryPaletteMessage>
          )
        )}
      </CommandGroup>
    );
  }

  if (projects.isError) {
    return (
      <CommandGroup heading="Jira">
        {isJiraAuthError(projects.error) && reauthConnection ? (
          <CommandPaletteItem
            icon={<JiraIcon />}
            title={pending ? tk('createFactory.jira.connecting') : tk('createFactory.jira.reconnect')}
            subtitle={tk('createFactory.linear.expired')}
            value="reconnect-jira"
            disabled={pending}
            onSelect={runConnect}
          />
        ) : (
          <CreateFactoryPaletteAlert>{projects.error.message}</CreateFactoryPaletteAlert>
        )}
      </CommandGroup>
    );
  }

  const allProjects = projects.data ?? [];
  const matchingProjects = allProjects.filter(project =>
    matches(`${project.name} ${project.key} ${project.site ?? ''}`),
  );

  return (
    <CommandGroup heading={tk('createFactory.jira.projects')}>
      {matchingProjects.map(project => (
        <CommandPaletteItem
          key={project.id}
          icon={<JiraIcon />}
          title={project.name}
          subtitle={
            [project.key, project.site].filter(Boolean).join(' · ') || tk('createFactory.jira.projectHint')
          }
          shortcut={<Kbd size="sm">↵</Kbd>}
          value={`jira-${project.id}`}
          onSelect={() => onSelectProject(project.id)}
        />
      ))}
      {matchingProjects.length === 0 && (
        <CreateFactoryPaletteMessage>
          {allProjects.length > 0 ? tk('createFactory.jira.noMatch') : tk('createFactory.jira.noProjects')}
        </CreateFactoryPaletteMessage>
      )}
    </CommandGroup>
  );
}
