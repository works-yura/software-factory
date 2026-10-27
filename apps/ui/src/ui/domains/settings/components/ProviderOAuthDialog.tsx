import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
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
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OAuthStartResponse } from '../../../../api/types';
import { useCompleteProviderOAuth, usePollProviderOAuth } from '../../../../hooks/use-providers';
import { providerDisplayName } from '@factory/credentials/provider-display-name';

interface ProviderOAuthDialogProps {
  provider: string;
  session: OAuthStartResponse;
  scopeNotice?: string;
  onClose: () => void;
  onComplete: () => void;
}

export function ProviderOAuthDialog(props: ProviderOAuthDialogProps) {
  if (props.session.kind === 'paste-code') {
    return <PasteCodeDialog {...props} />;
  }

  return <DeviceCodeDialog {...props} />;
}

function openAuthorizationUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function PasteCodeDialog({ provider, session, onClose, onComplete, scopeNotice }: ProviderOAuthDialogProps) {
  const { t } = useTranslation('settings');
  const displayName = providerDisplayName(provider);
  const completeMutation = useCompleteProviderOAuth();
  const [code, setCode] = useState('');

  const complete = async () => {
    const authorizationCode = code.trim();
    if (!authorizationCode || completeMutation.isPending) return;
    try {
      await completeMutation.mutateAsync({ provider, sessionId: session.sessionId, code: authorizationCode });
      onComplete();
    } catch {}
  };

  const close = () => {
    if (!completeMutation.isPending) onClose();
  };

  return (
    <Dialog open onOpenChange={open => !open && close()} pending={completeMutation.isPending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('oauth.title', { name: displayName })}</DialogTitle>
          <DialogDescription>{scopeNotice ?? t('oauth.pasteCodeDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Txt as="p" variant="caption" tone="muted">
            {session.instructions}
          </Txt>
          <Button onClick={() => openAuthorizationUrl(session.url)}>
            <ExternalLink />
            {t('oauth.openPage')}
          </Button>
          <Input
            autoFocus
            aria-label={t('oauth.code')}
            placeholder={t('oauth.codePlaceholder')}
            value={code}
            disabled={completeMutation.isPending}
            onChange={event => setCode(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void complete();
            }}
          />
          {completeMutation.error instanceof Error && (
            <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
              {completeMutation.error.message}
            </Txt>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('oauth.cancel')}</DialogCancel>
          <DialogAction disabled={!code.trim()} onConfirm={() => void complete()}>
            {completeMutation.isPending ? t('oauth.completing') : t('oauth.complete')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceCodeDialog({ provider, session, onClose, onComplete, scopeNotice }: ProviderOAuthDialogProps) {
  const { t } = useTranslation('settings');
  const displayName = providerDisplayName(provider);
  const pollMutation = usePollProviderOAuth();
  const { mutate: poll } = pollMutation;
  const completeSignIn = useEffectEvent(() => onComplete());
  const [nextPollAt, setNextPollAt] = useState(() => Date.now() + (session.nextPollMs ?? 1000));
  const [flowError, setFlowError] = useState<string>();

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        poll(
          { provider, sessionId: session.sessionId },
          {
            onSuccess: response => {
              if (response.status === 'complete') {
                completeSignIn();
                return;
              }
              if (response.status === 'failed') {
                setFlowError(response.error);
                return;
              }
              setNextPollAt(Date.now() + response.nextPollMs);
            },
            onError: error => setFlowError(error instanceof Error ? error.message : String(error)),
          },
        );
      },
      Math.max(0, nextPollAt - Date.now()),
    );

    return () => window.clearTimeout(timer);
  }, [nextPollAt, poll, provider, session.sessionId]);

  const close = () => {
    if (!pollMutation.isPending) onClose();
  };

  return (
    <Dialog open onOpenChange={open => !open && close()}>
      <DialogContent>
        <DialogHeader className="items-center text-center">
          <DialogTitle>{t('oauth.title', { name: displayName })}</DialogTitle>
          <DialogDescription>
            {scopeNotice ?? t('oauth.deviceCodeDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="items-center text-center">
          {session.userCode && (
            <div className="flex w-full min-w-0 items-center justify-center gap-2">
              <Txt
                as="span"
                variant="title"
                font="mono"
                className="min-w-0 flex-1 tracking-widest break-all select-all"
              >
                {session.userCode}
              </Txt>
              <CopyButton content={session.userCode} variant="ghost" size="icon-sm" tooltip={t('oauth.copyCode')} />
            </div>
          )}
          <Button className="w-full" onClick={() => openAuthorizationUrl(session.url)}>
            <ExternalLink />
            {t('oauth.openPage')}
          </Button>
        </DialogBody>
        <DialogFooter>
          {flowError ? (
            <Txt
              as="p"
              variant="caption"
              className="text-destructive-foreground mr-auto min-w-0 break-words"
              role="alert"
            >
              {flowError}
            </Txt>
          ) : (
            <div className="text-muted-foreground mr-auto flex items-center gap-2" role="status">
              <Loader2 size={14} className="motion-safe:animate-spin motion-reduce:animate-none" />
              <Txt as="span" variant="caption">
                {t('oauth.waiting')}
              </Txt>
            </div>
          )}
          <DialogCancel disabled={pollMutation.isPending}>{t('oauth.cancel')}</DialogCancel>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
