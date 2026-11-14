import { Brain } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import { SettingsContainer, SettingsGroup, SettingsTitle } from '@mastra/playground-ui/new/settings';

import { useAvailableModelsQuery } from '../../../../hooks/useAvailableModels';
import { useProviderConnectionState } from '../hooks/useProviderConnectionState';
import { settingsSectionPath } from '../settingsSections';
import { useFactoryHarness } from './models/harness/HarnessSettings';
import {
  MODEL_DEFAULTS_TONES,
  MODEL_LANES,
  MODEL_LANE_ICONS,
  MODEL_LANE_LABELS,
} from './models/routing/model-routes';
import type { ModelDefaults, ModelLane } from './models/routing/model-routes';
import { OMSection } from './OMSection';

export function MemorySettings({ factoryId }: { factoryId: string }) {
  const { anyConnected, providersKnown } = useProviderConnectionState();
  const { harness, descriptor } = useFactoryHarness(factoryId);
  const { t } = useTranslation('settings');

  // A harness without observational memory (Claude Code compacts its own context) has nothing to set here.
  // The nav hides the section on such a Factory, so only a direct link lands here.
  if (harness !== undefined && !descriptor.supports.memory) {
    return (
      <EmptyState
        as="h2"
        iconSlot={<Brain />}
        titleSlot={t('memory.turnHarness.title', { harness: descriptor.label })}
        descriptionSlot={t('memory.turnHarness.description', { harness: descriptor.label })}
        actionSlot={
          <Link to={settingsSectionPath(factoryId, 'models')} className={buttonVariants({ variant: 'default' })}>
            {t('memory.turnHarness.action')}
          </Link>
        }
      />
    );
  }

  if (providersKnown && !anyConnected) {
    return (
      <EmptyState
        variant="fill"
        as="h2"
        iconSlot={<Brain />}
        titleSlot={t('memory.empty.title')}
        descriptionSlot={t('memory.empty.description')}
        actionSlot={
          <Link to={settingsSectionPath(factoryId, 'models')} className={buttonVariants({ variant: 'primary' })}>
            {t('memory.empty.action')}
          </Link>
        }
      />
    );
  }

  return (
    <MemoryGroup title={t('memory.factoryCard')} info={t('memory.description')} defaults="factory" usedBy={MODEL_LANES}>
      <FactoryOMSection factoryId={factoryId} />
    </MemoryGroup>
  );
}

function FactoryOMSection({ factoryId }: { factoryId: string }) {
  const modelsQuery = useAvailableModelsQuery({ factoryProjectId: factoryId });
  return <OMSection factoryId={factoryId} models={modelsQuery.data ?? []} />;
}

/** One memory section: a dimmed title (the description in its tooltip, the lanes it serves beside it) over its card. */
function MemoryGroup({
  title,
  info,
  defaults,
  usedBy,
  children,
}: {
  title: string;
  info: string;
  defaults: ModelDefaults;
  usedBy: readonly ModelLane[];
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const tone = MODEL_DEFAULTS_TONES[defaults];
  return (
    <SettingsGroup>
      <SettingsTitle
        info={info}
        accessory={
          <Txt as="span" variant="meta" tone="muted" className="flex items-center gap-2">
            {t('memory.usedBy')}{' '}
            {usedBy.map(lane => {
              const UsedByIcon = MODEL_LANE_ICONS[lane];
              return (
                <span
                  key={lane}
                  className="bg-fill-subtle text-foreground inline-flex h-6 items-center gap-1.5 rounded-md px-2"
                >
                  <UsedByIcon className={cn('size-3.5', tone)} aria-hidden="true" />
                  {MODEL_LANE_LABELS[lane]}
                </span>
              );
            })}
          </Txt>
        }
      >
        {title}
      </SettingsTitle>
      <SettingsContainer>{children}</SettingsContainer>
    </SettingsGroup>
  );
}
