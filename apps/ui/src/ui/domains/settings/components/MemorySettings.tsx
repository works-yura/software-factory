import { Brain } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { Card, CardContent } from '@mastra/playground-ui/components/Card';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';

import { useAvailableModelsQuery } from '../../../../hooks/useAvailableModels';
import { useProviderConnectionState } from '../hooks/useProviderConnectionState';
import { settingsSectionPath } from '../settingsSections';
import { IconTile } from './models/routing/IconTile';
import {
  MODEL_DEFAULTS_ICONS,
  MODEL_DEFAULTS_TONES,
  MODEL_LANES,
  MODEL_LANE_ICONS,
  MODEL_LANE_LABELS,
} from './models/routing/model-routes';
import type { ModelDefaults, ModelLane } from './models/routing/model-routes';
import { SettingsSubsection } from './SettingsSubsection';
import { OMSection } from './OMSection';

export function MemorySettings({ factoryId }: { factoryId: string }) {
  const { anyConnected, providersKnown } = useProviderConnectionState();
  const { t } = useTranslation('settings');

  if (providersKnown && !anyConnected) {
    return (
      <EmptyState
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
    <SettingsSubsection title={t('memory.title')} description={t('memory.description')}>
      <div className="flex flex-col gap-3">
        <MemoryCard title={t('memory.factoryCard')} defaults="factory" usedBy={MODEL_LANES}>
          <FactoryOMSection factoryId={factoryId} />
        </MemoryCard>
      </div>
    </SettingsSubsection>
  );
}

function FactoryOMSection({ factoryId }: { factoryId: string }) {
  const modelsQuery = useAvailableModelsQuery({ factoryProjectId: factoryId });
  return <OMSection factoryId={factoryId} models={modelsQuery.data ?? []} />;
}

function MemoryCard({
  title,
  defaults,
  usedBy,
  children,
}: {
  title: string;
  defaults: ModelDefaults;
  usedBy: readonly ModelLane[];
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const tone = MODEL_DEFAULTS_TONES[defaults];
  return (
    <Card as="section" aria-label={title}>
      <CardContent className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <IconTile icon={MODEL_DEFAULTS_ICONS[defaults]} className={tone} />
          <Txt as="h3" variant="label" className="flex-1">
            {title}
          </Txt>
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
        </header>
        {children}
      </CardContent>
    </Card>
  );
}
