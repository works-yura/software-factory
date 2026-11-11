import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { AppWindow } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GitLabIcon } from '../../../../../ui/icons';
import { MASTRA_HARNESS } from '@factory/contracts/harnesses';

import { DefaultModelSummary } from '../defaults/DefaultModelSummary';
import { ProviderList } from '../providers/ProviderList';
import { DefaultsCard } from './DefaultsCard';
import { LaneCard, LaneSource } from './LaneCard';
import { MODEL_ROUTES } from './model-routes';
import { RoutingMapLayout, createConnectorAnchors } from './RoutingMapLayout';

export function ModelRoutingMap({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const [anchors] = useState(createConnectorAnchors);

  return (
    <RoutingMapLayout
      anchors={anchors}
      routes={MODEL_ROUTES}
      lanes={
        <>
          <LaneCard lane="chats" destination={MODEL_ROUTES.chats} anchorRef={anchors.chats}>
            <LaneSource label={t('routing.sources.webApp')}>
              <AppWindow />
            </LaneSource>
          </LaneCard>
          <LaneCard lane="runs" destination={MODEL_ROUTES.runs} anchorRef={anchors.runs}>
            <LaneSource label="GitHub">
              <GithubIcon />
            </LaneSource>
            <LaneSource label="GitLab">
              <GitLabIcon />
            </LaneSource>
          </LaneCard>
        </>
      }
      defaults={
        <DefaultsCard
          defaults="factory"
          anchorRef={anchors.factory}
          model={<DefaultModelSummary factoryId={factoryId} harnessId={MASTRA_HARNESS.id} />}
          providers={<ProviderList credentialScope="org" />}
        />
      }
    />
  );
}
