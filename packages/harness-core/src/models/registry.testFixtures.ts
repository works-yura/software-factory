// A third harness for tests: what a Codex harness would register, with its own catalog and
// descriptors and nothing else.
import type { ModelSelection, ServerProviderModel } from './contracts.ts';
import type { HarnessModels } from './facet.ts';
import { checkModelSelection } from './selection.ts';

/** A third harness as a Codex port would add it: its own catalog and descriptors, nothing else. */
export function codexStubModels(owned: ReadonlySet<string>): HarnessModels & { selections: Map<string, ModelSelection | null> } {
  const models: ServerProviderModel[] = [
    {
      slug: 'gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning',
            type: 'select',
            role: 'reasoning',
            options: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium', isDefault: true },
              { id: 'high', label: 'High' },
            ],
          },
          { id: 'fastMode', label: 'Fast', type: 'boolean' },
        ],
      },
    },
    { slug: 'gpt-5-mini', name: 'GPT-5 mini', isCustom: false, capabilities: { optionDescriptors: [] } },
  ];
  const selections = new Map<string, ModelSelection | null>();
  return {
    instanceId: 'codex-stub',
    harnessId: 'codex',
    displayName: 'Codex',
    selections,
    owns: async sessionId => owned.has(sessionId),
    list: async () => models,
    defaultSelection: async () => ({ instanceId: 'codex-stub', model: 'gpt-5.3-codex' }),
    check: async request => checkModelSelection('codex-stub', models, request),
    getSelection: async sessionId => selections.get(sessionId) ?? null,
    setSelection: async (sessionId, selection) => {
      selections.set(sessionId, selection);
      return { ok: true, modelSelection: selection, appliesFrom: 'next-turn' };
    },
  };
}

