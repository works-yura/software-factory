import { Button } from '@mastra/playground-ui/components/Button';
import {
  ThinkingLevelBars,
  ThinkingLevelPicker,
  ThinkingLevelUnavailable,
} from '@mastra/playground-ui/components/ThinkingLevel';
import type { ThinkingLevelOption } from '@mastra/playground-ui/components/ThinkingLevel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
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
  lockedReason?: string;
}

type ThinkingControlState =
  | { unavailableReason: string; lockedLevel?: ThinkingLevelSetting }
  | { effective: EffectiveThinkingLevel };

function thinkingControlState({
  catalog,
  thinking,
  switchingModel,
  lockedReason,
}: {
  catalog: { isPending: boolean };
  thinking: ChatThinkingApi;
  switchingModel: boolean;
  lockedReason: string | undefined;
}): ThinkingControlState {
  if (catalog.isPending) return { unavailableReason: tk('thinking.catalogLoading') };
  if (thinking.loadError) return { unavailableReason: tk('thinking.loadFailed') };
  if (!thinking.level) return { unavailableReason: tk('thinking.notLoaded') };
  if (switchingModel) return { unavailableReason: tk('thinking.switchingModel') };
  if (lockedReason) return { unavailableReason: lockedReason, lockedLevel: thinking.level.level };
  return { effective: thinking.level };
}

function showFailure(fallback: string) {
  return (cause: unknown) => toast.error(cause instanceof Error ? cause.message : fallback);
}

function originLabel(origin: ThinkingLevelOrigin) {
  return origin === 'session' ? tk('thinking.thisSession') : factoryThinkingSourceLabel();
}

export function SessionThinkingControl({ modelId, switchingModel, lockedReason }: SessionThinkingControlProps) {
  const { t } = useTranslation('chat');
  const thinking = useChatThinking();
  const { catalogTarget } = useChatModelCatalog();
  const catalog = useAvailableModelsQuery(catalogTarget);
  const reasoningOptions = useModelReasoningOptions(modelId, catalogTarget);
  const options = thinkingLevelOptionsForModel(modelId, reasoningOptions);
  const state = thinkingControlState({ catalog, thinking, switchingModel, lockedReason });

  if ('unavailableReason' in state) {
    if (state.lockedLevel) {
      return (
        <ThinkingLevelLocked
          options={options}
          label={t('thinking.label')}
          reason={state.unavailableReason}
          value={state.lockedLevel}
        />
      );
    }
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

interface ThinkingLevelLockedProps<T extends string> {
  options: readonly ThinkingLevelOption<T>[];
  label: string;
  reason: string;
  /** The level still in effect: the control is locked, not unsupported. */
  value: T;
}

/**
 * `ThinkingLevelUnavailable` that still shows the level in effect. Upstream adds a
 * `value` prop to the library control (8fb8a82428); @mastra/playground-ui 65.0.0
 * has none, so the locked state is drawn here.
 */
function ThinkingLevelLocked<T extends string>({ options, label, reason, value }: ThinkingLevelLockedProps<T>) {
  const { t } = useTranslation('chat');
  const level = options.find(option => option.value === value)?.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-disabled="true"
            aria-label={t('thinking.lockedLabel', { label, level: level ?? value, reason })}
            className={cn(
              'inline-flex h-control-sm shrink-0 cursor-not-allowed items-center rounded-full border border-transparent px-2.5 text-placeholder',
              focusRing,
            )}
          />
        }
      >
        <ThinkingLevelBars options={options} value={value} />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {reason}
      </TooltipContent>
    </Tooltip>
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
