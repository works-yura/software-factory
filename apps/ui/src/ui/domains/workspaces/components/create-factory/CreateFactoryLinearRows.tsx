import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { LinearIcon } from '@mastra/playground-ui/icons/LinearIcon';
import { ArrowRight } from 'lucide-react';

import { useLinearProjectsQuery, useLinearStatusQuery } from '../../../../../hooks/useLinearData';
import { isLinearReauthError } from '../../../factory/services/linear';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryLinearRowsProps {
  query: string;
  onConnect: () => void;
  onSelectProject: (projectId: string) => void;
  onSkip: () => void;
}

export function CreateFactoryLinearRows({ query, onConnect, onSelectProject, onSkip }: CreateFactoryLinearRowsProps) {
  const linearStatus = useLinearStatusQuery();
  const status = linearStatus.data;
  const connected = status?.connected === true;
  const projects = useLinearProjectsQuery(connected);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (title: string) => title.toLowerCase().includes(normalizedQuery);

  const skipTitle = tk('actions.skipForNow');
  const skipRow = matches(skipTitle) && (
    <CommandPaletteItem
      icon={<ArrowRight />}
      title={skipTitle}
      subtitle={tk('createFactory.linear.skipHint')}
      value="skip-linear"
      onSelect={onSkip}
    />
  );

  if (linearStatus.isPending || (connected && projects.isPending)) {
    return (
      <SkeletonRows label={tk('createFactory.linear.loading')} rows={2} rowClassName="mx-2 my-1 h-12 rounded-xl" />
    );
  }

  if (!connected) {
    const connectable = status?.reason !== 'missing_config' && status?.reason !== 'organization_required';
    const connectTitle =
      status?.reason === 'not_connected' ? tk('vcs.connect', { host: 'Linear' }) : tk('createFactory.linear.reconnect');
    return (
      <CommandGroup heading="Linear">
        {skipRow}
        {connectable ? (
          matches(connectTitle) && (
            <CommandPaletteItem
              icon={<LinearIcon />}
              title={connectTitle}
              subtitle={tk('createFactory.linear.connectHint')}
              value="connect-linear"
              onSelect={onConnect}
            />
          )
        ) : (
          <CreateFactoryPaletteMessage>{tk('createFactory.linear.notConfigured')}</CreateFactoryPaletteMessage>
        )}
      </CommandGroup>
    );
  }

  if (projects.isError) {
    return (
      <CommandGroup heading="Linear">
        {skipRow}
        {isLinearReauthError(projects.error) ? (
          <CommandPaletteItem
            icon={<LinearIcon />}
            title={tk('createFactory.linear.reconnect')}
            subtitle={tk('createFactory.linear.expired')}
            value="connect-linear"
            onSelect={onConnect}
          />
        ) : (
          <CreateFactoryPaletteAlert>{projects.error.message}</CreateFactoryPaletteAlert>
        )}
      </CommandGroup>
    );
  }

  const allProjects = projects.data ?? [];
  const matchingProjects = allProjects.filter(project => matches(project.name));

  return (
    <CommandGroup heading={tk('createFactory.linear.projectsIn', { workspace: status.workspace?.name ?? 'Linear' })}>
      {skipRow}
      {matchingProjects.map(project => (
        <CommandPaletteItem
          key={project.id}
          icon={<LinearIcon />}
          title={project.name}
          subtitle={project.teams.map(team => team.name).join(', ') || tk('createFactory.linear.projectHint')}
          shortcut={<Kbd size="sm">↵</Kbd>}
          value={`linear-${project.id}`}
          onSelect={() => onSelectProject(project.id)}
        />
      ))}
      {matchingProjects.length === 0 && (
        <CreateFactoryPaletteMessage>
          {allProjects.length > 0 ? tk('createFactory.linear.noMatch') : tk('createFactory.linear.noProjects')}
        </CreateFactoryPaletteMessage>
      )}
    </CommandGroup>
  );
}
