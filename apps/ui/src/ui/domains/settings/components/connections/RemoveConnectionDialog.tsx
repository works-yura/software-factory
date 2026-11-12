import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useConnectionImpact, useDisconnectConnection } from '../../../../../hooks/useConnections';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * «Видалити підключення» for a connection the server describes. Before anything is deleted it reads
 * what removing it does — what depends on it and, per item, whether it moves, is unlinked or stops —
 * and shows the server's own words; confirming does exactly that. Nothing is lost silently.
 */
export function RemoveConnectionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const impact = useConnectionImpact(id);
  const remove = useDisconnectConnection();
  const data = impact.data;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{data?.title ?? t('connections.actions.deleteConnection')}</DialogTitle>
          <DialogDescription>{data?.body ?? ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-3">
          {impact.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" aria-hidden />
              <Txt as="span" variant="caption" tone="muted">
                {t('connections.connector.reading')}
              </Txt>
            </span>
          ) : impact.isError ? (
            <Notice variant="destructive" title={t('connections.connector.impactFailed')} role="alert">
              <Notice.Message>{errorMessage(impact.error)}</Notice.Message>
            </Notice>
          ) : data ? (
            <>
              {data.warning && (
                <Notice variant="warning" title={data.warning} role="status" />
              )}
              {data.dependents.length > 0 && (
                <ul className="flex flex-col gap-0.5" aria-label={t('connections.connector.dependents')}>
                  {data.dependents.map(dependent => (
                    <li key={dependent.label}>
                      <Txt as="span" variant="body-sm" tone="ink">
                        {dependent.label}
                      </Txt>
                    </li>
                  ))}
                </ul>
              )}
              {data.items.length > 0 && (
                <>
                  {data.itemsLabel && (
                    <Txt as="p" variant="caption" tone="muted">
                      {data.itemsLabel}
                    </Txt>
                  )}
                  <ul className="flex flex-col gap-1.5" aria-label={data.itemsLabel ?? t('connections.connector.dependents')}>
                    {data.items.map(item => (
                      <li key={item.label} className="flex min-w-0 flex-col" data-outcome={item.outcome}>
                        <Txt as="span" variant="body-sm" tone="ink" className="break-all">
                          {item.label}
                        </Txt>
                        <Txt as="span" variant="caption" tone="muted">
                          {item.outcomeLabel}
                        </Txt>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : null}
          {remove.isError && (
            <Notice variant="destructive" title={t('connections.connector.removeFailed')} role="alert">
              <Notice.Message>{errorMessage(remove.error)}</Notice.Message>
            </Notice>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {data?.cancelLabel ?? t('connections.delete.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!data || remove.isPending}
            onClick={() =>
              data &&
              remove.mutate(
                { id, confirm: data.requiresConfirm },
                {
                  onSuccess: result => {
                    toast.success(result.message);
                    onClose();
                  },
                },
              )
            }
          >
            {data?.confirmLabel ?? t('connections.delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
