import { Badge } from '@mastra/playground-ui/components/Badge';
import { buttonVariants } from '@mastra/playground-ui/components/Button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@mastra/playground-ui/components/Command';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { cn } from '@mastra/playground-ui/utils/cn';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import type { AvailableModelOption } from '../../../../../hooks/useAvailableModels';
import { useAvailableModelsQuery } from '../../../../../hooks/useAvailableModels';
import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { useChatConnection } from '../../context/useChatConnection';
import { useChatModelCatalog } from '../../context/useChatModelCatalog';
import type { ChatSessionContextApi } from '../../context/ChatSessionContext';
import { useChatModels } from '../../context/useChatModels';
import { useChatSessionContext } from '../../context/useChatSessionContext';
import { settingsSectionPath } from '../../../settings/settingsSections';
import { ClaudeCodeModelLabel } from './ClaudeCodeModelLabel';
import { LockedModelButton } from './LockedModelButton';
import { ModelThinkingGroup } from './ModelThinkingGroup';

function groupByProvider(models: AvailableModelOption[]): [string, AvailableModelOption[]][] {
  const groups = new Map<string, AvailableModelOption[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function canSwitchModel({
  kind,
  draftSessionId,
  sessionEnabled,
  modelLockedReason,
  harness,
}: Pick<ChatSessionContextApi, 'kind' | 'draftSessionId' | 'sessionEnabled' | 'modelLockedReason' | 'harness'>): boolean {
  if (modelLockedReason) return false;
  // The Factory picks this harness's model (Settings → Models); a session has nothing to switch.
  if (harness?.modelScope === 'factory') return false;
  if (kind === 'user' && draftSessionId) return true;
  return sessionEnabled;
}

function useModelSwitch() {
  const { t } = useTranslation('chat');
  const chatSession = useChatSessionContext();
  const { activeModelId, defaultModelId, pendingModelId, setModel } = useChatModels();
  const { catalogTarget, catalogLoading } = useChatModelCatalog();
  const modelsQuery = useAvailableModelsQuery(catalogTarget);

  const selectedModelId = pendingModelId ?? activeModelId;
  const busy = Boolean(pendingModelId);

  const pickModel = (modelId: string) => {
    if (busy || modelId === activeModelId) return;
    void setModel(modelId).catch((cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : t('modelPicker.switchFailed'));
    });
  };

  return {
    modelsQuery,
    activeModelId,
    selectedModelId,
    defaultModelId,
    catalogLoading,
    busy,
    switchable: canSwitchModel(chatSession),
    locked: busy || modelsQuery.isPending || catalogLoading,
    pickModel,
  };
}

type ModelSwitch = ReturnType<typeof useModelSwitch>;

interface ModelMenuProps {
  modelSwitch: ModelSwitch;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  children: ReactNode;
}

function ModelMenu({ modelSwitch, triggerClassName, triggerAriaLabel, children }: ModelMenuProps) {
  const { t } = useTranslation('chat');
  const { modelsQuery, selectedModelId, defaultModelId, locked, pickModel } = modelSwitch;
  const [open, setOpen] = useState(false);

  const choose = (modelId: string) => {
    setOpen(false);
    pickModel(modelId);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={locked}
        aria-label={triggerAriaLabel}
        aria-busy={locked}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), triggerClassName ?? 'text-muted-foreground')}
        title={selectedModelId}
      >
        {children}
        <ChevronDown aria-hidden size={12} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command loop>
          <CommandInput placeholder={t('modelPicker.search')} />
          <CommandList className="max-h-80">
            <CommandEmpty>{t('modelPicker.noMatch')}</CommandEmpty>
            {groupByProvider(modelsQuery.data ?? []).map(([provider, models]) => (
              <CommandGroup
                key={provider}
                heading={provider}
                className="[&_[cmdk-group-heading]]:text-placeholder [&_[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:tracking-normal [&_[cmdk-group-heading]]:normal-case"
              >
                {models.map(model => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    keywords={[model.provider, model.modelName, formatModelName(model.id)]}
                    title={model.id}
                    onSelect={() => choose(model.id)}
                  >
                    <span className="truncate">{model.modelName}</span>
                    {model.id === defaultModelId ? (
                      <Badge variant="blue" size="xs">
                        {t('common.default')}
                      </Badge>
                    ) : null}
                    {model.id === selectedModelId ? <Check aria-hidden className="ml-auto shrink-0" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ModelPicker() {
  const { t } = useTranslation('chat');
  const modelSwitch = useModelSwitch();
  const { modelsQuery, activeModelId, selectedModelId, catalogLoading, switchable, busy } = modelSwitch;
  const { modelLockedReason, claudeCode, harness } = useChatSessionContext();
  const { status } = useChatConnection();
  const { isLoading, error } = useChatModels();
  const { factoryId } = useParams<{ factoryId: string }>();
  const organizationScoped = useFactoryAuth().data?.authEnabled === true;

  // A harness whose model is the Factory's (Claude Code) shows it; nothing to pick per session.
  if (claudeCode || harness?.modelScope === 'factory') {
    return <ClaudeCodeModelLabel model={claudeCode?.model ?? null} factoryId={factoryId} />;
  }

  if (!selectedModelId && (isLoading || status === 'connecting')) {
    return <Skeleton aria-label={t('modelPicker.loading')} className="h-3.5 w-24" />;
  }
  if (!selectedModelId && error) {
    return (
      <span className="text-destructive-foreground" aria-label={t('modelPicker.unavailable')} title={error.message}>
        {t('modelPicker.unavailable')}
      </span>
    );
  }

  if (modelLockedReason && activeModelId) {
    return (
      <ModelThinkingGroup modelId={activeModelId} switchingModel={false} lockedReason={modelLockedReason}>
        <LockedModelButton modelId={activeModelId} reason={modelLockedReason} />
      </ModelThinkingGroup>
    );
  }

  const label = selectedModelId ? formatModelName(selectedModelId) : t('modelPicker.noModel');
  const notConfigured =
    !catalogLoading &&
    Boolean(selectedModelId) &&
    modelsQuery.isSuccess &&
    !modelsQuery.data.some(model => model.id === selectedModelId);

  const noModelsToOffer = !modelsQuery.isPending && !modelsQuery.data?.length;
  if (modelsQuery.isError && noModelsToOffer) {
    const unavailableLabel = t('modelPicker.listUnavailable', { label });
    return (
      <span className="text-destructive-foreground" aria-label={unavailableLabel} title={modelsQuery.error.message}>
        {unavailableLabel}
      </span>
    );
  }
  if (!switchable || noModelsToOffer) {
    if (notConfigured && organizationScoped && factoryId) {
      return (
        <span className="text-destructive-foreground" title={selectedModelId}>
          {label} ·{' '}
          <Link to={settingsSectionPath(factoryId, 'models')} className="underline underline-offset-2">
            {t('modelPicker.needsOrgCredential')}
          </Link>
        </span>
      );
    }
    return (
      <span
        className={notConfigured ? 'text-destructive-foreground' : 'text-muted-foreground'}
        aria-label={notConfigured ? t('modelPicker.isNotConfigured', { label }) : undefined}
        title={selectedModelId}
      >
        {label}
        {notConfigured ? ` · ${t('modelPicker.notConfigured')}` : null}
      </span>
    );
  }

  return (
    <ModelThinkingGroup modelId={activeModelId} switchingModel={busy}>
      <ModelMenu
        modelSwitch={modelSwitch}
        triggerAriaLabel={
          notConfigured ? t('modelPicker.sessionModelNotConfigured', { label }) : t('modelPicker.sessionModel')
        }
        triggerClassName={notConfigured ? 'text-destructive-foreground' : undefined}
      >
        <span className="max-w-48 truncate">
          {label}
          {notConfigured ? ` · ${t('modelPicker.notConfigured')}` : null}
        </span>
      </ModelMenu>
    </ModelThinkingGroup>
  );
}

/** The session's own picker, offered on a run error card: only the session knows which models its credentials reach. */
export function ChangeModelAction() {
  const { t } = useTranslation('chat');
  const modelSwitch = useModelSwitch();
  if (!modelSwitch.switchable || !modelSwitch.modelsQuery.data?.length) return null;
  return <ModelMenu modelSwitch={modelSwitch}>{t('modelPicker.changeModel')}</ModelMenu>;
}
