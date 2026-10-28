import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Factory } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface CreateFactoryNameRowsProps {
  name: string;
  disabled?: boolean;
  onSubmit: (name: string) => void;
}

/** The palette field doubles as the Factory name field, so its row commits what was typed. */
export function CreateFactoryNameRows({ name, disabled, onSubmit }: CreateFactoryNameRowsProps) {
  const { t } = useTranslation('workspaces');
  const trimmedName = name.trim();

  return (
    <CommandGroup heading={t('createFactory.nameGroup')}>
      <CommandPaletteItem
        icon={<Factory />}
        title={trimmedName ? t('createFactory.createNamed', { name: trimmedName }) : t('createFactory.typeName')}
        shortcut={<Kbd size="sm">↵</Kbd>}
        value="create-factory"
        disabled={disabled || !trimmedName}
        onSelect={() => onSubmit(trimmedName)}
      />
    </CommandGroup>
  );
}
