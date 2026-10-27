import { CommandPaletteRail, CommandPaletteScope } from '@mastra/playground-ui/components/CommandPalette';
import { Factory, GitBranch, GitPullRequest, Route, Search, SquareKanban, Ticket } from 'lucide-react';

import type { GlobalSearchScope, GlobalSearchScopeCounts } from '../services/searchScopes';
import { useTranslation } from 'react-i18next';

export function GlobalSearchRail({
  activeScope,
  counts,
  onScopeChange,
}: {
  activeScope: GlobalSearchScope;
  counts: GlobalSearchScopeCounts;
  onScopeChange: (scope: GlobalSearchScope) => void;
}) {
  const { t } = useTranslation('search');
  return (
    <CommandPaletteRail aria-label={t('categories')}>
      <CommandPaletteScope
        icon={<Search />}
        label={t('scopes.all')}
        count={counts.all}
        active={activeScope === 'all'}
        onSelect={() => onScopeChange('all')}
      />
      <CommandPaletteScope
        icon={<Route />}
        label={t('scopes.navigation')}
        count={counts.navigation}
        active={activeScope === 'navigation'}
        onSelect={() => onScopeChange('navigation')}
      />
      <CommandPaletteScope
        icon={<SquareKanban />}
        label={t('scopes.work')}
        count={counts.work}
        active={activeScope === 'work'}
        onSelect={() => onScopeChange('work')}
      />
      <CommandPaletteScope
        icon={<GitPullRequest />}
        label={t('scopes.review')}
        count={counts.review}
        active={activeScope === 'review'}
        onSelect={() => onScopeChange('review')}
      />
      <CommandPaletteScope
        icon={<Ticket />}
        label={t('scopes.items')}
        count={counts.items}
        active={activeScope === 'items'}
        onSelect={() => onScopeChange('items')}
      />
      <CommandPaletteScope
        icon={<GitBranch />}
        label={t('scopes.user')}
        count={counts.user}
        active={activeScope === 'user'}
        onSelect={() => onScopeChange('user')}
      />
      <CommandPaletteScope
        icon={<Factory />}
        label={t('scopes.factories')}
        count={counts.factories}
        active={activeScope === 'factories'}
        onSelect={() => onScopeChange('factories')}
      />
    </CommandPaletteRail>
  );
}
