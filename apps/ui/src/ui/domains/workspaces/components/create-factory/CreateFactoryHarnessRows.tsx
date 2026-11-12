import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { useTranslation } from 'react-i18next';

import { useHarnessChoices } from '../../../../../hooks/useHarnessChoices';
import { BrandLogo } from '../../../settings/components/connections/ConnectionIcon';
import { isFactoryHarness } from '../../services/github';
import type { FactoryHarness } from '../../services/github';
import { CreateFactoryPaletteMessage } from './CreateFactoryPalette';

export interface CreateFactoryHarnessRowsProps {
  /** The pick already in the draft, marked when the user steps back to this step. */
  selected?: FactoryHarness;
  disabled?: boolean;
  onSelect: (harness: FactoryHarness) => void;
}

/**
 * Which runtime the Factory's agents run on: the harnesses the server runs, as it describes them,
 * offered only when this person can run them (ADR-0036: a harness on connections they lack is not;
 * the server's reason says where to connect one). Switchable later in settings, for new sessions.
 */
export function CreateFactoryHarnessRows({ selected, disabled, onSelect }: CreateFactoryHarnessRowsProps) {
  const { t } = useTranslation('workspaces');
  const { choices } = useHarnessChoices();
  const offered = choices.filter(choice => choice.usable || choice.descriptor.id === selected);
  const missing = choices.filter(choice => !choice.usable && choice.descriptor.id !== selected);

  return (
    <>
      <CreateFactoryPaletteMessage>{t('createFactory.harness.changeLaterNote')}</CreateFactoryPaletteMessage>
      <CommandGroup heading={t('createFactory.harness.group')}>
        {offered.map(({ descriptor }) => (
          <CommandPaletteItem
            key={descriptor.id}
            icon={<BrandLogo kind={descriptor.icon} size={16} />}
            title={descriptor.label}
            subtitle={t(`createFactory.harness.descriptions.${descriptor.id}`, { defaultValue: '' }) || undefined}
            badge={selected === descriptor.id ? t('createFactory.harness.selected') : undefined}
            value={`harness-${descriptor.id}`}
            disabled={disabled}
            onSelect={() => {
              if (isFactoryHarness(descriptor.id)) onSelect(descriptor.id);
            }}
          />
        ))}
      </CommandGroup>
      {missing.map(choice => (
        <CreateFactoryPaletteMessage key={choice.descriptor.id}>
          {t('createFactory.harness.notOffered', { name: choice.descriptor.label, reason: choice.reason ?? '' })}
        </CreateFactoryPaletteMessage>
      ))}
    </>
  );
}
