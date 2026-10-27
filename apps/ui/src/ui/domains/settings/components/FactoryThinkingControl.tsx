import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import { ThinkingLevelPicker, ThinkingLevelUnavailable } from '@mastra/playground-ui/components/ThinkingLevel';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';

import { translator } from '../../../i18n/t';

import { useFactoryThinkingDefaultQuery, useSetFactoryThinkingDefaultMutation } from '../../../../hooks/use-thinking';
import { ALL_THINKING_LEVEL_OPTIONS } from '../../chat/services/thinkingLevels';

const tk = translator('settings');

function thinkingWriteFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return tk('models.thinking.changeFailed');
  if ('status' in error && error.status === 403) return tk('models.thinking.adminsOnly');
  return error.message;
}

export function FactoryThinkingControl({ factoryId }: { factoryId: string }) {
  const levelQuery = useFactoryThinkingDefaultQuery(factoryId);
  const setLevel = useSetFactoryThinkingDefaultMutation(factoryId);
  const { t } = useTranslation('settings');

  if (levelQuery.isError) {
    return (
      <ThinkingLevelUnavailable
        options={ALL_THINKING_LEVEL_OPTIONS}
        label={t('models.thinking.label')}
        reason={t('models.thinking.loadFailed')}
      />
    );
  }
  if (levelQuery.data === undefined) {
    return (
      <ThinkingLevelUnavailable
        options={ALL_THINKING_LEVEL_OPTIONS}
        label={t('models.thinking.label')}
        reason={t('models.thinking.notLoaded')}
      />
    );
  }

  return (
    <ThinkingLevelPicker
      options={ALL_THINKING_LEVEL_OPTIONS}
      value={levelQuery.data}
      label={t('models.thinking.label')}
      description={t('models.thinking.description')}
      onChange={(level: ThinkingLevelSetting) =>
        setLevel.mutateAsync(level).catch(error => toast.error(thinkingWriteFailureMessage(error)))
      }
    />
  );
}
