import { Button } from '@mastra/playground-ui/components/Button';
import { ThinkingLevelPicker, ThinkingLevelUnavailable } from '@mastra/playground-ui/components/ThinkingLevel';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { translator } from '../../../../i18n/t';
import { useChatModelCatalog } from '../../context/useChatModelCatalog';

import { useAvailableModelsQuery, useModelReasoningOptions } from '../../../../../hooks/useAvailableModels';
import type { ChatThinkingApi } from '../../context/ChatThinkingContext';
import { useChatThinking } from '../../context/useChatThinking';
import { factoryThinkingSourceLabel, thinkingLevelOptionsForModel } from '../../services/thinkingLevels';
import type { EffectiveThinkingLevel, ThinkingLevelOrigin } from '../../services/thinkingLevels';

const tk = translator('chat');

interface SessionThinkingControlProps {
  modelId: string;
  switchingModel: boolean;
}

type ThinkingControlState = { unavailableReason: string } | { effective: EffectiveThinkingLevel };

function thinkingControlState({
  catalog,
  thinking,
  switchingModel,
}: {
  catalog: { isPending: boolean };
  thinking: ChatThinkingApi;
  switchingModel: boolean;
}): ThinkingControlState {
  if (catalog.isPending) return { unavailableReason: tk('thinking.catalogLoading') };
  if (thinking.loadError) return { unavailableReason: tk('thinking.loadFailed') };
  if (!thinking.level) return { unavailableReason: tk('thinking.notLoaded') };
  if (switchingModel) return { unavailableReason: tk('thinking.switchingModel') };
  return { effective: thinking.level };
}

function showFailure(fallback: string) {
  return (cause: unknown) => toast.error(cause instanceof Error ? cause.message : fallback);
}

function originLabel(origin: ThinkingLevelOrigin) {
  return origin === 'session' ? tk('thinking.thisSession') : factoryThinkingSourceLabel();
}

export function SessionThinkingControl({ modelId, switchingModel }: SessionThinkingControlProps) {
  const { t } = useTranslation('chat');
  const thinking = useChatThinking();
  const { catalogTarget } = useChatModelCatalog();
  const catalog = useAvailableModelsQuery(catalogTarget);
  const reasoningOptions = useModelReasoningOptions(modelId, catalogTarget);
  const options = thinkingLevelOptionsForModel(modelId, reasoningOptions);
  const state = thinkingControlState({ catalog, thinking, switchingModel });

  if ('unavailableReason' in state) {
    return <ThinkingLevelUnavailable options={options} label={t('thinking.label')} reason={state.unavailableReason} />;
  }

  const { level, origin } = state.effective;
  const source = originLabel(origin);

  return (
    <ThinkingLevelPicker
      options={options}
      value={level}
      label={t('thinking.label')}
      origin={source}
      footer={
        <ThinkingLevelOriginNote
          source={source}
          setForSession={origin === 'session'}
          onUseDefault={() => thinking.resetLevel().catch(showFailure(t('thinking.resetFailed')))}
        />
      }
      onChange={next => thinking.setLevel(next).catch(showFailure(t('thinking.changeFailed')))}
    />
  );
}

interface ThinkingLevelOriginNoteProps {
  source: string;
  setForSession: boolean;
  onUseDefault: () => void;
}

function ThinkingLevelOriginNote({ source, setForSession, onUseDefault }: ThinkingLevelOriginNoteProps) {
  const { t } = useTranslation('chat');
  if (!setForSession) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('thinking.follows', { source })}
      </Txt>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <Txt as="p" variant="caption" tone="muted">
        {t('thinking.setForSession')}
      </Txt>
      <Button variant="ghost" size="sm" onClick={onUseDefault}>
        {t('thinking.useDefault')}
      </Button>
    </div>
  );
}
