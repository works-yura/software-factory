import { useKeyboardShortcutLabel } from '@mastra/playground-ui/hooks/use-keyboard-shortcut-label';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { Search } from 'lucide-react';

import { useGlobalSearchControls } from '../hooks/useGlobalSearchControls';
import { useTranslation } from 'react-i18next';

// Hidden in the mobile drawer — the chat header owns the trigger at that width
export function SidebarGlobalSearchButton() {
  const { openSearch } = useGlobalSearchControls();
  const shortcutLabel = useKeyboardShortcutLabel('K');
  const { t } = useTranslation('nav');

  return (
    <Sidebar.SearchTrigger
      id="global-search-sidebar-trigger"
      aria-label={t('searchAndNavigate')}
      shortcut={shortcutLabel}
      className="ml-auto hidden md:inline-flex"
      onClick={event => openSearch(event.currentTarget)}
    >
      <Search />
    </Sidebar.SearchTrigger>
  );
}
