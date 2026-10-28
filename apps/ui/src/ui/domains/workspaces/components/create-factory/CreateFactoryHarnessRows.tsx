import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Boxes } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FactoryHarness } from '../../services/github';
import { ProviderBrandIcon } from '../ProviderBrandIcon';
import { CreateFactoryPaletteMessage } from './CreateFactoryPalette';

export interface CreateFactoryHarnessRowsProps {
  /** The pick already in the draft, marked when the user steps back to this step. */
  selected?: FactoryHarness;
  disabled?: boolean;
  onSelect: (harness: FactoryHarness) => void;
}

/** Which runtime the Factory's agents run on. Switchable later in settings, for new sessions. */
export function CreateFactoryHarnessRows({ selected, disabled, onSelect }: CreateFactoryHarnessRowsProps) {
  const { t } = useTranslation('workspaces');

  return (
    <>
      <CreateFactoryPaletteMessage>{t('createFactory.harness.changeLaterNote')}</CreateFactoryPaletteMessage>
      <CommandGroup heading={t('createFactory.harness.group')}>
        <CommandPaletteItem
          icon={<Boxes />}
          title={t('createFactory.harness.mastra.title')}
          subtitle={t('createFactory.harness.mastra.description')}
          badge={selected === 'mastra' ? t('createFactory.harness.selected') : undefined}
          value="harness-mastra"
          disabled={disabled}
          onSelect={() => onSelect('mastra')}
        />
        <CommandPaletteItem
          icon={<ProviderBrandIcon provider="anthropic" />}
          title={t('createFactory.harness.claudeCode.title')}
          subtitle={t('createFactory.harness.claudeCode.description')}
          badge={selected === 'claude-code' ? t('createFactory.harness.selected') : undefined}
          value="harness-claude-code"
          disabled={disabled}
          onSelect={() => onSelect('claude-code')}
        />
      </CommandGroup>
    </>
  );
}
