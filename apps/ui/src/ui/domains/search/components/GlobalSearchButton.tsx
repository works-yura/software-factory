import { Button } from '@mastra/playground-ui/components/Button';
import { Search } from 'lucide-react';

import { useGlobalSearchControls } from '../hooks/useGlobalSearchControls';
import { useTranslation } from 'react-i18next';

export function GlobalSearchButton({ id }: { id: string }) {
  const { t } = useTranslation('search');
  const { openSearch } = useGlobalSearchControls();

  return (
    <Button
      id={id}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('button')}
      tooltip={t('button')}
      onClick={event => openSearch(event.currentTarget)}
    >
      <Search />
    </Button>
  );
}
