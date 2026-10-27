import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Ticket } from 'lucide-react';

import type { WorkItemSearchResult } from '../services/searchResults';
import { translator } from '../../../i18n/t';

const tk = translator('search');

export function GlobalSearchWorkItemResults({
  results,
  onSelect,
}: {
  results: WorkItemSearchResult[];
  onSelect: (result: WorkItemSearchResult) => void;
}) {
  if (results.length === 0) return null;

  return (
    <CommandGroup heading={tk('scopes.items')}>
      {results.map(result => (
        <CommandPaletteItem
          key={result.id}
          icon={<Ticket />}
          title={result.title}
          subtitle={result.context}
          badge={result.identifier}
          value={result.value}
          onSelect={() => onSelect(result)}
        />
      ))}
    </CommandGroup>
  );
}
