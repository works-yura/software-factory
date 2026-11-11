import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { useChatConnection } from '../../context/useChatConnection';
import type { ChatSessionContextApi } from '../../context/ChatSessionContext';
import { useChatModels } from '../../context/useChatModels';
import { useChatSessionContext } from '../../context/useChatSessionContext';
import { settingsSectionPath } from '../../../settings/settingsSections';
import { ComposerEffortColumn, ComposerPickerFooter, describeComposerEffort } from '../modelPicker/ComposerModelEffort';
import { markOpenToEffort, ProviderModelPicker } from '../modelPicker/ProviderModelPicker';
import { useComposerSelection } from '../modelPicker/useComposerSelection';
import { ClaudeCodeModelLabel } from './ClaudeCodeModelLabel';
import { LockedModelButton } from './LockedModelButton';
import { ModelThinkingGroup } from './ModelThinkingGroup';

function canSwitchModel({
  kind,
  draftSessionId,
  sessionEnabled,
  modelLockedReason,
}: Pick<ChatSessionContextApi, 'kind' | 'draftSessionId' | 'sessionEnabled' | 'modelLockedReason'>): boolean {
  if (modelLockedReason) return false;
  if (kind === 'user' && draftSessionId) return true;
  return sessionEnabled;
}

/** The `modelPicker.toggle` (`mod+shift+m`) and `composer.effort` (`mod+shift+e`) shortcuts. */
function pickerShortcut(event: KeyboardEvent): 'toggle' | 'effort' | null {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.repeat) return null;
  const key = event.key.toLowerCase();
  if (key === 'm') return 'toggle';
  if (key === 'e') return 'effort';
  return null;
}

function usePickerShortcuts(enabled: boolean, onShortcut: (shortcut: 'toggle' | 'effort') => void) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const shortcut = pickerShortcut(event);
    if (!shortcut || event.defaultPrevented) return;
    event.preventDefault();
    onShortcut(shortcut);
  });
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => handle(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}

/** The session's model and effort: the composer picker with its docked effort column. */
function SessionModelPicker({
  busy,
  disabled = false,
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  docked = true,
  shortcuts = false,
}: {
  busy: boolean;
  /** A switch the session is still making: the picker waits for it, as v4's picker did. */
  disabled?: boolean;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  docked?: boolean;
  shortcuts?: boolean;
}) {
  const selection = useComposerSelection();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const effort = describeComposerEffort(selection.traits, 'bars', 'sm');

  usePickerShortcuts(shortcuts, shortcut => {
    if (shortcut === 'toggle') {
      setOpen(current => !current);
      return;
    }
    if (open) {
      const column = document.querySelector('[data-model-picker-effort]');
      (
        column?.querySelector<HTMLElement>('[data-effort-level][aria-checked="true"]') ??
        column?.querySelector<HTMLElement>('[data-effort-row]')
      )?.focus();
      return;
    }
    if (triggerRef.current) markOpenToEffort(triggerRef.current);
    setOpen(true);
  });

  return (
    <ProviderModelPicker
      activeInstanceId={selection.selectedInstanceId}
      model={selection.selectedModel}
      // Every harness stays listed: a pick on another one says why it needs a new chat.
      lockedProvider={null}
      instanceEntries={selection.providerInstanceEntries}
      modelOptionsByInstance={selection.modelOptionsByInstance}
      open={open}
      onOpenChange={setOpen}
      busy={busy}
      disabled={disabled}
      triggerRef={triggerRef}
      triggerLabel={triggerLabel}
      triggerClassName={triggerClassName}
      triggerAriaLabel={triggerAriaLabel}
      onOpenProviderSetup={selection.openProviderSetup}
      onInstanceModelChange={selection.onProviderModelSelect}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      {...(docked
        ? {
            effortColumn: (
              <ComposerEffortColumn
                traits={selection.traits}
                unavailableReason={selection.effortUnavailableReason}
              />
            ),
            footer: <ComposerPickerFooter traits={selection.traits} origin={selection.origin} />,
          }
        : {})}
    />
  );
}

export function ModelPicker() {
  const { t } = useTranslation('chat');
  const chatSession = useChatSessionContext();
  const { modelLockedReason, harness } = chatSession;
  // A chat whose harness took its model from the Factory before it could pick one (Claude Code).
  const claudeCode = chatSession.claudeCode ?? (harness?.modelScope === 'factory' ? { model: null } : undefined);
  const { status } = useChatConnection();
  const { activeModelId, pendingModelId, isLoading, error } = useChatModels();
  const selection = useComposerSelection();
  const { factoryId } = useParams<{ factoryId: string }>();
  const organizationScoped = useFactoryAuth().data?.authEnabled === true;
  const switchable = canSwitchModel(chatSession);
  const catalogQuery = selection.catalogQuery;

  // A server without the Claude Code catalog: the chat runs on the Factory's Claude model.
  if (claudeCode && !selection.lockedEntry && !catalogQuery.isPending) {
    return <ClaudeCodeModelLabel model={claudeCode.model} factoryId={factoryId} />;
  }

  const selectedModelId = selection.selectedModel || (claudeCode ? undefined : (pendingModelId ?? activeModelId));
  if (!selectedModelId && (isLoading || status === 'connecting' || catalogQuery.isPending)) {
    return <Skeleton aria-label={t('modelPicker.loading')} className="h-3.5 w-24" />;
  }
  if (!selectedModelId && error && !claudeCode) {
    return (
      <span className="text-destructive-foreground" aria-label={t('modelPicker.unavailable')} title={error.message}>
        {t('modelPicker.unavailable')}
      </span>
    );
  }

  if (modelLockedReason && selectedModelId) {
    return claudeCode ? (
      <LockedModelButton modelId={selectedModelId} reason={modelLockedReason} />
    ) : (
      <ModelThinkingGroup modelId={selectedModelId} switchingModel={false} lockedReason={modelLockedReason}>
        <LockedModelButton modelId={selectedModelId} reason={modelLockedReason} />
      </ModelThinkingGroup>
    );
  }

  const label = selectedModelId ? formatModelName(selectedModelId) : t('modelPicker.noModel');
  const instanceModels = selection.lockedEntry?.models ?? [];
  const notConfigured =
    !claudeCode &&
    Boolean(selectedModelId) &&
    catalogQuery.isSuccess &&
    !instanceModels.some(model => model.slug === selectedModelId);

  const noModelsToOffer = !catalogQuery.isPending && instanceModels.length === 0;
  if (catalogQuery.isError && noModelsToOffer) {
    const unavailableLabel = t('modelPicker.listUnavailable', { label });
    return (
      <span className="text-destructive-foreground" aria-label={unavailableLabel} title={catalogQuery.error.message}>
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
    <SessionModelPicker
      busy={Boolean(pendingModelId) || (selection.pendingPick !== null && !chatSession.draftSessionId)}
      disabled={Boolean(pendingModelId)}
      shortcuts
      triggerAriaLabel={
        notConfigured ? t('modelPicker.sessionModelNotConfigured', { label }) : t('modelPicker.sessionModel')
      }
      triggerClassName={notConfigured ? 'text-destructive-foreground' : undefined}
    />
  );
}

/** The session's own picker, offered on a run error card: only the session knows which models its credentials reach. */
export function ChangeModelAction() {
  const { t } = useTranslation('chat');
  const chatSession = useChatSessionContext();
  const { pendingModelId } = useChatModels();
  const selection = useComposerSelection();
  if (!canSwitchModel(chatSession) || !selection.lockedEntry?.models.length) return null;
  return (
    <SessionModelPicker
      busy={Boolean(pendingModelId)}
      disabled={Boolean(pendingModelId)}
      docked={false}
      triggerLabel={t('modelPicker.changeModel')}
      triggerClassName="text-foreground"
    />
  );
}
