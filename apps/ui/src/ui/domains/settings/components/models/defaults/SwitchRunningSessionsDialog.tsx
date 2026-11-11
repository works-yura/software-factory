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
import { useTranslation } from 'react-i18next';

/** After a new default: also move the running sessions of its harness onto it? */
export function SwitchRunningSessionsDialog({
  modelName,
  pending,
  onConfirm,
  onClose,
}: {
  modelName: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('models.factoryDefault.confirmTitle', { model: modelName })}</DialogTitle>
          <DialogDescription>{t('models.factoryDefault.confirmDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancel>{t('models.factoryDefault.keep')}</DialogCancel>
          <DialogAction onConfirm={onConfirm}>
            {pending ? t('models.factoryDefault.switching') : t('models.factoryDefault.switch')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
