import { CommandPaletteDialog } from '@mastra/playground-ui/components/CommandPalette';
import { useParams } from 'react-router';

import { FactoryGlobalSearchContent } from './FactoryGlobalSearchContent';
import { useTranslation } from 'react-i18next';

export function GlobalSearchDialog({ closeSearch }: { closeSearch: () => void }) {
  const { t } = useTranslation('search');
  const { factoryId } = useParams<{ factoryId: string }>();
  const updateOpen = (open: boolean) => {
    if (!open) closeSearch();
  };

  return (
    <CommandPaletteDialog
      open
      onOpenChange={updateOpen}
      title={t('dialog.title')}
      description={t('dialog.description')}
      commandLabel={t('dialog.commandLabel')}
    >
      {factoryId && <FactoryGlobalSearchContent factoryId={factoryId} closeSearch={closeSearch} />}
    </CommandPaletteDialog>
  );
}
