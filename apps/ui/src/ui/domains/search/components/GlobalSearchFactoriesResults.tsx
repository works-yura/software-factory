import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Factory } from 'lucide-react';

import type { GlobalSearchSelectHandler } from '../services/searchNavigation';
import { factoryHomePath } from '../../workspaces/services/factoryPaths';
import type { FactoryProject } from '../../workspaces/services/github';
import { translator } from '../../../i18n/t';

const tk = translator('search');

function factoryContext(repositorySlugs: string[]): string {
  if (repositorySlugs.length === 0) return tk('factories.noRepositories');
  return repositorySlugs.join(', ');
}

function currentFactoryShortcut(factoryId: string, activeFactoryId: string | undefined): string | undefined {
  if (factoryId === activeFactoryId) return tk('factories.current');
  return undefined;
}

export function GlobalSearchFactoriesResults({
  factories,
  activeFactoryId,
  onSelect,
}: {
  factories: FactoryProject[];
  activeFactoryId: string | undefined;
  onSelect: GlobalSearchSelectHandler;
}) {
  if (factories.length === 0) return null;

  return (
    <CommandGroup heading={tk('scopes.factories')}>
      {factories.map(factory => {
        const repositorySlugs = factory.repositories.map(repository => repository.slug);
        return (
          <CommandPaletteItem
            key={factory.id}
            icon={<Factory />}
            title={factory.name}
            subtitle={factoryContext(repositorySlugs)}
            value={`${factory.name} ${factory.id} ${repositorySlugs.join(' ')} Factory`}
            shortcut={currentFactoryShortcut(factory.id, activeFactoryId)}
            onSelect={() => onSelect(factoryHomePath(factory), false)}
          />
        );
      })}
    </CommandGroup>
  );
}
