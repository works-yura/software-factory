import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { useTranslation } from 'react-i18next';

import { useDeleteRequests } from './api';

/**
 * Asks before deleting requests for good — one from its menu, or every one a filter shows — then
 * deletes them with their threads, notes, memory and files. `onDeleted` runs once they are gone.
 */
export function DeleteRequestsDialog({
  ids,
  open,
  onOpenChange,
  onDeleted,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation('assistant');
  const remove = useDeleteRequests();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('delete.title', { count: ids.length })}</AlertDialog.Title>
          <AlertDialog.Description>{t('delete.description', { count: ids.length })}</AlertDialog.Description>
        </AlertDialog.Header>
        {remove.isError ? <Notice variant="destructive">{remove.error.message}</Notice> : null}
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{t('actions.cancel')}</AlertDialog.Cancel>
          <AlertDialog.Action onClick={() => remove.mutate(ids, { onSuccess: () => onDeleted?.() })}>
            {t('delete.confirm', { count: ids.length })}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
