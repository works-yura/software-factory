import { THINKING_LEVEL_VALUES, getAvailableThinkingLevelsForModel, runThinkingLevel } from '@mastra/code-sdk/thinking';
import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import type { ModelReasoningOption } from '@mastra/core/llm';
import type { ThinkingLevelOption } from '@mastra/playground-ui/components/ThinkingLevel';

import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevelSetting, string>> = lazyLabels(
  THINKING_LEVEL_VALUES,
  level => `chat:thinking.levels.${level}`,
);

const THINKING_LEVEL_EMPHASIS: Partial<Record<ThinkingLevelSetting, ThinkingLevelOption['emphasis']>> = {
  off: 'muted',
  xhigh: 'warning',
  max: 'warning',
};

function thinkingLevelOptions(levels: readonly ThinkingLevelSetting[]): ThinkingLevelOption<ThinkingLevelSetting>[] {
  // The label is a getter so options built once (ALL_THINKING_LEVEL_OPTIONS) follow the language.
  return levels.map(level => ({
    value: level,
    get label() {
      return THINKING_LEVEL_LABELS[level];
    },
    emphasis: THINKING_LEVEL_EMPHASIS[level],
  }));
}

export const ALL_THINKING_LEVEL_OPTIONS = thinkingLevelOptions(THINKING_LEVEL_VALUES);

export function thinkingLevelOptionsForModel(
  modelId: string,
  reasoningOptions: readonly ModelReasoningOption[] | undefined,
): ThinkingLevelOption<ThinkingLevelSetting>[] {
  return thinkingLevelOptions(getAvailableThinkingLevelsForModel(modelId, reasoningOptions));
}

export type ThinkingLevelOrigin = 'session' | 'factory';

export function factoryThinkingSourceLabel(): string {
  return tk('commands.factoryDefault');
}

export interface EffectiveThinkingLevel {
  level: ThinkingLevelSetting;
  origin: ThinkingLevelOrigin;
}

function chosenThinkingLevel(
  override: ThinkingLevelSetting | undefined,
  factoryDefault: ThinkingLevelSetting | undefined,
): EffectiveThinkingLevel | undefined {
  if (override) return { level: override, origin: 'session' };
  if (!factoryDefault) return undefined;
  return { level: factoryDefault, origin: 'factory' };
}

export function resolveEffectiveThinkingLevel({
  modelId,
  reasoningOptions,
  override,
  factoryDefault,
}: {
  modelId: string | undefined;
  reasoningOptions: readonly ModelReasoningOption[] | undefined;
  override: ThinkingLevelSetting | undefined;
  factoryDefault: ThinkingLevelSetting | undefined;
}): EffectiveThinkingLevel | undefined {
  const chosen = chosenThinkingLevel(override, factoryDefault);
  if (!chosen || !modelId) return chosen;
  return { ...chosen, level: runThinkingLevel(modelId, chosen.level, reasoningOptions) };
}
