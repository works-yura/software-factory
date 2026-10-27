import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import type { DropdownMenuRadioOption } from '@mastra/playground-ui/components/DropdownMenu';
import { Columns2, Ellipsis, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { DiffLayout } from '../../../hooks/useDiffLayout';
import { useTranslation } from 'react-i18next';

import { lazyOption } from '../../../../../i18n/lazy';

const DIFF_LAYOUT_OPTIONS: readonly DropdownMenuRadioOption<DiffLayout>[] = [
  lazyOption<DiffLayout>('unified', 'workspaces:changes.layout.unified'),
  lazyOption<DiffLayout>('split', 'workspaces:changes.layout.split'),
];

interface ChangesOptionsMenuProps {
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  onRefresh: () => void;
}

export function ChangesOptionsMenu({ layout, onLayoutChange, onRefresh }: ChangesOptionsMenuProps) {
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  const pickLayout = (picked: DiffLayout) => {
    setOpen(false);
    onLayoutChange(picked);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger variant="ghost" size="icon-sm" tooltip={t('changes.options')} aria-label={t('changes.options')}>
        <Ellipsis />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioSub
          label={t('changes.layout.label')}
          icon={<Columns2 aria-hidden />}
          options={DIFF_LAYOUT_OPTIONS}
          value={layout}
          onValueChange={pickLayout}
        />
        <DropdownMenu.Item onClick={onRefresh}>
          <RefreshCw aria-hidden />
          <span>{t('changes.refreshShort')}</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
