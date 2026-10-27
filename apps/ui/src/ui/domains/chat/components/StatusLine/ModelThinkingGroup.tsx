import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionThinkingControl } from './SessionThinkingControl';

interface ModelThinkingGroupProps {
  children: ReactNode;
  modelId?: string;
  switchingModel: boolean;
  lockedReason?: string;
}

export function ModelThinkingGroup({ children, modelId, switchingModel, lockedReason }: ModelThinkingGroupProps) {
  const { t } = useTranslation('chat');
  return (
    <ButtonsGroup size="sm" aria-label={t('modelPicker.group')}>
      {children}
      {modelId ? (
        <SessionThinkingControl modelId={modelId} switchingModel={switchingModel} lockedReason={lockedReason} />
      ) : null}
    </ButtonsGroup>
  );
}
