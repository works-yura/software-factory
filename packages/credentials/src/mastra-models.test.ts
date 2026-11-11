import { describe, expect, it } from 'vitest';

import { checkOptionSelections, modelSwitchBetween } from '@factory/harness/models/selection';
import { formatModelSelectionEffort } from '@factory/harness/models/threadExecution';

import { mastraModelCapabilities, mastraModelInstance, mastraModelSelection } from './mastra-models.ts';

describe('Mastra descriptors', () => {
  it('offers a reasoning select only for a model with a choice', () => {
    expect(mastraModelCapabilities(['off'])).toEqual({ optionDescriptors: [] });
    const capabilities = mastraModelCapabilities(['off', 'low', 'high', 'xhigh']);
    expect(capabilities.optionDescriptors?.[0]).toMatchObject({
      id: 'effort',
      type: 'select',
      role: 'reasoning',
      options: [
        { id: 'off', label: 'Off' },
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra High' },
      ],
    });
    expect(checkOptionSelections({ slug: 'openai/gpt-5', capabilities }, [{ id: 'effort', value: 'max' }]).ok).toBe(false);
  });

  it('labels the switch divider', () => {
    const models = [
      { slug: 'anthropic/claude-opus-4-6', name: 'Opus', isCustom: false, capabilities: mastraModelCapabilities(['low', 'high']) },
    ];
    const from = mastraModelSelection('anthropic/claude-opus-4-6', 'high');
    const to = mastraModelSelection('anthropic/claude-opus-4-6', 'low');
    expect(formatModelSelectionEffort(from, models)).toBe('High');
    expect(modelSwitchBetween(from, to)).toEqual({ modelSwitch: { from, to } });
    expect(modelSwitchBetween(from, mastraModelSelection('anthropic/claude-opus-4-6', 'high'))).toEqual({});
  });

  it('lists a catalog as the Mastra instance, offering setup when it is empty', () => {
    const instance = mastraModelInstance(
      [{ id: 'openai/gpt-5', provider: 'openai', modelName: 'GPT-5', capabilities: mastraModelCapabilities(['low', 'high']) }],
      'openai/gpt-5',
    );
    expect(instance).toMatchObject({
      instanceId: 'mastra',
      harnessId: 'mastra',
      available: true,
      needsSetup: false,
      defaultModel: 'openai/gpt-5',
      models: [{ slug: 'openai/gpt-5', name: 'GPT-5', subProvider: 'OpenAI', isDefault: true }],
    });
    expect(mastraModelInstance([], null)).toMatchObject({ available: false, needsSetup: true, models: [] });
  });
});
