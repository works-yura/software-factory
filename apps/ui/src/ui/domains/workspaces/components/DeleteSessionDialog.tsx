import {
  Dialog,
  DialogAction,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Trans, useTranslation } from 'react-i18next';

import type { SessionListRow } from '../services/sessionRows';

export function DeleteSessionDialog({
  row,
  pending,
  onCancel,
  onConfirm,
}: {
  row: SessionListRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('workspaces');
  const factorySession = row.origin === 'factory';
  const highlight = { name: <span className="text-foreground" /> };
  return (
    <Dialog open onOpenChange={open => !open && onCancel()} intent="destructive" pending={pending}>
      <DialogContent size="sm" aria-label={factorySession ? t('deleteSession.workspaceLabel') : t('deleteSession.userLabel')}>
        <DialogHeader>
          <DialogTitle>{factorySession ? t('deleteSession.workspaceTitle') : t('deleteSession.userTitle')}</DialogTitle>
          <DialogDescription>
            {factorySession ? (
              <Trans
                t={t}
                i18nKey="deleteSession.workspaceDescription"
                values={{ branch: row.session.branch }}
                components={highlight}
              />
            ) : (
              <Trans t={t} i18nKey="deleteSession.userDescription" values={{ name: row.name }} components={highlight} />
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancel>{t('actions.cancel')}</DialogCancel>
          <DialogAction onConfirm={onConfirm}>{pending ? t('actions.deleting') : t('actions.delete')}</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
