import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import {
  useConnectPlatformProviderMutation,
  useReconnectPlatformProviderMutation,
} from '../../../../hooks/usePlatformConnections';
import { useConnectors } from '../../../../hooks/useConnections';
import type { PlatformConnectProviderId, PlatformProviderConnection } from '../../factory/services/platformConnect';
import { translator } from '../../../i18n/t';

const tk = translator('settings');

/**
 * A Platform provider's name and how it authorizes, as the server's connector describes it
 * (ADR-0035): the UI keeps no provider registry of its own.
 */
function useProviderMeta(provider: PlatformConnectProviderId): { displayName: string; authKind: 'oauth' | 'apiKey' } {
  const connector = useConnectors().data?.connectors.find(candidate => candidate.id === provider);
  const method = connector?.methods.find(candidate => candidate.available === true) ?? connector?.methods[0];
  return { displayName: connector?.name ?? provider, authKind: method?.authKind ?? 'oauth' };
}

function connectionName(connection: PlatformProviderConnection): string {
  return connection.displayName?.trim() || connection.accountLabel?.trim() || tk('connectedAccounts.fallbackName');
}

interface ApiKeyDialogProps {
  provider: PlatformConnectProviderId;
  title: string;
  pending: boolean;
  onSubmit: (apiKey: string) => void;
  onClose: () => void;
}

function ApiKeyDialog({ provider, title, pending, onSubmit, onClose }: ApiKeyDialogProps) {
  const { t } = useTranslation('settings');
  const meta = useProviderMeta(provider);
  const [apiKey, setApiKey] = useState('');
  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('connectedAccounts.apiKeyDescription', { name: meta.displayName })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            aria-label={t('connectedAccounts.apiKeyLabel', { name: meta.displayName })}
            type="password"
            placeholder={t('connectedAccounts.apiKeyPlaceholder')}
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
          />
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('connectedAccounts.cancel')}</DialogCancel>
          <DialogAction disabled={!apiKey.trim()} onConfirm={() => onSubmit(apiKey.trim())}>
            {pending ? t('connectedAccounts.connecting') : t('connectedAccounts.connect')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProviderConnectControlProps {
  provider: PlatformConnectProviderId;
  /** Reconnect an existing connection instead of creating a new one. */
  reconnectConnectionId?: string;
  label: string;
  /** Short visible action when the provider is already named beside it. */
  buttonLabel?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost' | 'primary';
  /** Leading icon inside the button, e.g. the provider's logomark. */
  icon?: ReactNode;
  /** Layout classes forwarded to the connect button. */
  className?: string;
  /** Called after the provider confirmed the authorization. */
  onCompleted?: () => void;
}

/**
 * One button driving the full connect or reconnect flow for a provider.
 * Owns its mutation: mint session → headless auth → wait for activation.
 */
export function ProviderConnectControl({
  provider,
  reconnectConnectionId,
  label,
  buttonLabel,
  size = 'sm',
  variant = 'default',
  icon,
  className,
  onCompleted,
}: ProviderConnectControlProps) {
  const { t } = useTranslation('settings');
  const meta = useProviderMeta(provider);
  const connectMutation = useConnectPlatformProviderMutation(provider);
  const reconnectMutation = useReconnectPlatformProviderMutation(provider);
  const [collectingApiKey, setCollectingApiKey] = useState(false);
  const pending = connectMutation.isPending || reconnectMutation.isPending;

  const run = async (credentials?: Record<string, string>) => {
    try {
      const connection = reconnectConnectionId
        ? await reconnectMutation.mutateAsync({
            connectionId: reconnectConnectionId,
            ...(credentials ? { credentials } : {}),
          })
        : await connectMutation.mutateAsync({ ...(credentials ? { credentials } : {}) });
      setCollectingApiKey(false);
      if (connection) {
        toast.success(t('connectedAccounts.connected', { name: meta.displayName }));
      } else {
        toast.success(t('connectedAccounts.activating', { name: meta.displayName }));
      }
      onCompleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectedAccounts.connectFailed', { name: meta.displayName }));
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon={icon}
        className={className}
        disabled={pending}
        aria-label={buttonLabel && !pending ? label : undefined}
        onClick={() => (meta.authKind === 'apiKey' ? setCollectingApiKey(true) : void run())}
      >
        {pending ? t('connectedAccounts.connecting') : (buttonLabel ?? label)}
      </Button>
      {collectingApiKey && (
        <ApiKeyDialog
          provider={provider}
          title={label}
          pending={pending}
          onSubmit={apiKey => void run({ apiKey })}
          onClose={() => setCollectingApiKey(false)}
        />
      )}
    </>
  );
}

export interface ProviderConnectionsListProps {
  provider: PlatformConnectProviderId;
  connections: PlatformProviderConnection[];
}

/**
 * Per-connection rows for organizations with multiple installed accounts.
 * Healthy connections show a quiet reconnect affordance; connections the
 * provider rejected surface it prominently.
 */
export function ProviderConnectionsList({ provider, connections }: ProviderConnectionsListProps) {
  const { t } = useTranslation('settings');
  if (connections.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {connections.map(connection => (
        <li key={connection.id} className="flex items-center justify-between gap-2 px-4 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <Txt as="span" variant="caption" className="truncate">
              {connectionName(connection)}
            </Txt>
            {connection.status === 'needs_reauth' && (
              <Txt as="span" variant="meta" className="text-destructive-foreground">
                {t('connectedAccounts.needsReauth')}
              </Txt>
            )}
          </span>
          <ProviderConnectControl
            provider={provider}
            reconnectConnectionId={connection.id}
            label={t('connectedAccounts.reconnect')}
            size="sm"
            variant={connection.status === 'needs_reauth' ? 'default' : 'ghost'}
          />
        </li>
      ))}
    </ul>
  );
}
