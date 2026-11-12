import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CLAUDE_CODE_MODELS } from '@factory/harness-claude-code/models/aliases';

import { useModelCatalogQuery } from '../../../../../hooks/useAvailableModels';
import { useHarnessChoices } from '../../../../../hooks/useHarnessChoices';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { TURN_HARNESS_TEXT_KEY } from '../../services/turnHarness';
import type { TurnHarness } from '../../services/turnHarness';
import { useHarness } from '../../../../../hooks/useHarness';
import { BrandLogo } from '../../../settings/components/connections/ConnectionIcon';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';

export interface CreateFactoryTurnHarnessStepProps {
  harness: TurnHarness;
  query: string;
  /** The model being written to the Factory being created; null is the harness's own default. */
  saving?: { model: string | null };
  error?: string;
  onPick: (model: string | null) => void;
}

/** One model row: its id (null = the harness's default) and how it reads. */
interface ModelOption {
  model: string | null;
  title: string;
  description?: string;
}

/** The texts under `workspaces:createFactory.<key>`. */
const TURN_HARNESS_STEP: Record<TurnHarness, { key: (typeof TURN_HARNESS_TEXT_KEY)[TurnHarness] }> = {
  'claude-code': { key: TURN_HARNESS_TEXT_KEY['claude-code'] },
  codex: { key: TURN_HARNESS_TEXT_KEY.codex },
};

/** The models a new Factory of the harness may start on: Claude Code's CLI aliases, or Codex's catalog. */
function useModelOptions(harness: TurnHarness): { options: ModelOption[]; loading: boolean } {
  const { t } = useTranslation('workspaces');
  const catalog = useModelCatalogQuery();
  if (harness === 'claude-code') {
    return {
      loading: false,
      options: [null, ...CLAUDE_CODE_MODELS].map(model => ({
        model,
        title: t(`createFactory.claudeCode.models.${model ?? 'default'}.title`),
        description: t(`createFactory.claudeCode.models.${model ?? 'default'}.description`),
      })),
    };
  }
  const instance = catalog.data?.instances?.find(entry => entry.instanceId === harness);
  return {
    loading: catalog.isPending,
    options: [
      { model: null, title: t('createFactory.codex.models.default.title'), description: t('createFactory.codex.models.default.description') },
      ...(instance?.models ?? [])
        .filter(model => !model.isLegacy)
        .map(model => ({ model: model.slug, title: model.name, description: model.slug })),
    ],
  };
}

/**
 * The last step for a Factory on a turn-based harness (Claude Code, Codex): there is no provider to
 * connect (its runs sign in with the members' accounts), so it shows what turns will sign in with
 * and asks only which model to run, saved as the Factory's default for that harness.
 */
export function CreateFactoryTurnHarnessStep({ harness, query, saving, error, onPick }: CreateFactoryTurnHarnessStepProps) {
  const { t } = useTranslation('workspaces');
  const { key } = TURN_HARNESS_STEP[harness];
  const descriptor = useHarness(harness);
  const normalizedQuery = query.trim().toLowerCase();
  const { options, loading } = useModelOptions(harness);
  const models = options.filter(
    option => option.title.toLowerCase().includes(normalizedQuery) || (option.model ?? 'default').toLowerCase().includes(normalizedQuery),
  );
  const busy = saving !== undefined;

  return (
    <>
      {error && <CreateFactoryPaletteAlert>{error}</CreateFactoryPaletteAlert>}
      <TurnHarnessSignIn harness={harness} disabled={busy} />
      {loading ? (
        <SkeletonRows label={t(`createFactory.${key}.models.heading`)} rows={2} rowClassName="mx-2 my-1 h-8 rounded-xl" />
      ) : models.length > 0 ? (
        <CommandGroup heading={t(`createFactory.${key}.models.heading`)}>
          {models.map(option => {
            const id = option.model ?? 'default';
            return (
              <CommandPaletteItem
                key={id}
                icon={
                  busy && saving.model === option.model ? (
                    <Spinner size="sm" aria-label={t('createFactory.models.creating')} />
                  ) : option.model ? (
                    <BrandLogo kind={descriptor.icon} size={16} />
                  ) : (
                    <Sparkles />
                  )
                }
                title={option.title}
                subtitle={option.description}
                shortcut={<Kbd size="sm">↵</Kbd>}
                value={`${harness}-model-${id}`}
                disabled={busy}
                onSelect={() => onPick(option.model)}
              />
            );
          })}
        </CommandGroup>
      ) : (
        <CreateFactoryPaletteMessage>{t('createFactory.models.noMatch')}</CreateFactoryPaletteMessage>
      )}
    </>
  );
}

/**
 * Whether the harness can run for this person (ADR-0036): its accounts are connections, connected in
 * Settings › Підключення; when it cannot, the server says why. Nothing to sign in to here.
 */
function TurnHarnessSignIn({ harness }: { harness: TurnHarness; disabled: boolean }) {
  const { t } = useTranslation('workspaces');
  const { key } = TURN_HARNESS_STEP[harness];
  const { choices, isPending } = useHarnessChoices();
  const choice = choices.find(entry => entry.descriptor.id === harness);
  if (isPending) return <SkeletonRows label={t(`createFactory.${key}.signIn.loading`)} rows={1} rowClassName="mx-2 my-1 h-8 rounded-xl" />;
  if (!choice || choice.usable) return null;
  return (
    <CommandGroup heading={t(`createFactory.${key}.signIn.heading`)}>
      <CreateFactoryPaletteMessage>{choice.reason ?? t(`createFactory.${key}.signIn.none`)}</CreateFactoryPaletteMessage>
    </CommandGroup>
  );
}
