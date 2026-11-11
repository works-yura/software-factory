import { describe, expect, it } from 'vitest';

import { compileCodexTurn, codexEffortForThinkingLevel, getCodexServiceTierOptionValue, mapCodexModelCapabilities } from './codexModelOptions.ts';

describe('mapCodexModelCapabilities', () => {
  it('maps current Codex model capability fields', () => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      defaultReasoningEffort: 'super-high',
      description: 'Test model',
      displayName: 'GPT Test',
      hidden: false,
      id: 'gpt-test',
      isDefault: true,
      model: 'gpt-test',
      defaultServiceTier: 'flex',
      serviceTiers: [
        { id: 'priority', name: 'Fast', description: 'Lower latency responses.' },
        { id: 'flex', name: 'Flex', description: 'Lower-cost asynchronous routing.' },
      ],
      supportedReasoningEfforts: [{ description: 'Maximum reasoning', reasoningEffort: 'super-high' }],
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: 'effort',
        label: 'Reasoning',
        type: 'select',
        role: 'reasoning',
        options: [{ id: 'super-high', label: 'super-high', isDefault: true }],
        currentValue: 'super-high',
      },
      {
        id: 'serviceTier',
        label: 'Service Tier',
        type: 'select',
        options: [
          { id: 'default', label: 'Standard' },
          { id: 'priority', label: 'Fast', description: 'Lower latency responses.' },
          { id: 'flex', label: 'Flex', description: 'Lower-cost asynchronous routing.', isDefault: true },
        ],
        currentValue: 'flex',
      },
    ]);
  });

  it('uses standard routing when the catalog has no default service tier', () => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: ['fast'],
      defaultReasoningEffort: 'medium',
      defaultServiceTier: null,
      description: 'Test model',
      displayName: 'GPT Test',
      hidden: false,
      id: 'gpt-test',
      isDefault: true,
      model: 'gpt-test',
      serviceTiers: [
        { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
        { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' },
      ],
      supportedReasoningEfforts: [],
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: 'serviceTier',
        label: 'Service Tier',
        type: 'select',
        options: [
          { id: 'default', label: 'Standard', isDefault: true },
          { id: 'priority', label: 'Fast', description: '1.5x speed, increased usage' },
          { id: 'ultrafast', label: 'Ultrafast', description: 'Even faster, more expensive' },
        ],
        currentValue: 'default',
      },
    ]);
  });

  it('reads the older speed tiers when a model lists no service tiers', () => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: ['fast'],
      defaultReasoningEffort: 'low',
      description: '',
      displayName: 'GPT-6-Astra',
      hidden: false,
      id: 'gpt-6-astra',
      isDefault: false,
      model: 'gpt-6-astra',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
    });
    const [effort, tier] = capabilities.optionDescriptors ?? [];
    // Astra defaults to medium whatever the catalog says.
    expect(effort).toMatchObject({ id: 'effort', currentValue: 'medium' });
    expect(tier).toMatchObject({ id: 'serviceTier', options: [{ id: 'default' }, { id: 'fast', label: 'Fast' }] });
  });
});

describe('compileCodexTurn', () => {
  it("runs the session's own pick, else the Factory default, else Codex's own", () => {
    const own = { instanceId: 'codex', model: 'gpt-test-sol', options: [{ id: 'effort', value: 'high' }, { id: 'serviceTier', value: 'priority' }] };
    const factory = { instanceId: 'codex', model: 'gpt-test-luna' };
    expect(compileCodexTurn({ selection: own, factoryDefault: factory })).toEqual({
      selection: own,
      model: 'gpt-test-sol',
      effort: 'high',
      serviceTier: 'priority',
    });
    expect(compileCodexTurn({ selection: null, factoryDefault: factory })).toEqual({ selection: factory, model: 'gpt-test-luna' });
    expect(compileCodexTurn({})).toEqual({ selection: null });
  });

  it('sends no tier for Standard and reads a legacy fast mode as Fast', () => {
    expect(getCodexServiceTierOptionValue({ instanceId: 'codex', model: 'm', options: [{ id: 'serviceTier', value: 'default' }] })).toBeUndefined();
    expect(getCodexServiceTierOptionValue({ instanceId: 'codex', model: 'm', options: [{ id: 'fastMode', value: true }] })).toBe('fast');
  });

  it("maps Mastra's thinking levels onto Codex efforts", () => {
    expect(codexEffortForThinkingLevel('off')).toBe('minimal');
    expect(codexEffortForThinkingLevel('high')).toBe('high');
    expect(codexEffortForThinkingLevel('loud')).toBeUndefined();
  });
});
