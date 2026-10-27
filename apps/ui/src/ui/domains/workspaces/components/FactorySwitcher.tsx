import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { useSidebar } from '@mastra/playground-ui/components/Sidebar';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Check, ChevronDown, Factory as FactoryIcon, Plus } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useFactoriesQuery, useFactoryQuery } from '../../../../hooks/useFactories';
import { createFactoryPath, factorySwitchPath } from '../services/factoryPaths';
import { useTranslation } from 'react-i18next';

export function FactorySwitcher() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const location = useLocation();
  const factoriesQuery = useFactoriesQuery();
  const activeFactoryQuery = useFactoryQuery(factoryId);
  const factories = factoriesQuery.data ?? [];
  const activeFactory = activeFactoryQuery.data;
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();

  const createFactoryFrom = factoryId ?? factories[0]?.id;
  const openCreateFactory = () => {
    if (!createFactoryFrom) return;
    void navigate(createFactoryPath(createFactoryFrom));
    setOpenMobile(false);
  };

  const { t } = useTranslation('nav');
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        id="factory-switcher-trigger"
        type="button"
        aria-label={t('switcher.select')}
        variant="ghost"
        size="sm"
        className="-ml-[calc(var(--button-px)-2px)] min-w-0 gap-1"
      >
        <FactoryIcon />
        <Txt tone="ink" as="span" variant="caption" className="min-w-0 truncate">
          {activeFactory?.name ?? t('switcher.placeholder')}
        </Txt>
        <ChevronDown size={14} className="text-muted-foreground shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-64">
        {factories.map(factory => (
          <DropdownMenu.Item
            key={factory.id}
            onSelect={() => {
              void navigate(factorySwitchPath(factory, location));
            }}
          >
            <FactoryIcon />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{factory.name}</span>
            </span>
            {factory.id === activeFactory?.id && <Check aria-label={t('switcher.active')} />}
          </DropdownMenu.Item>
        ))}

        {factories.length > 0 && <DropdownMenu.Separator />}
        <DropdownMenu.Item disabled={!createFactoryFrom} onSelect={openCreateFactory}>
          <Plus />
          <span>{t('switcher.create')}</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
