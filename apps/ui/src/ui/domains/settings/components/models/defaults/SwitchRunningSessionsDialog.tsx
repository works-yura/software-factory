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
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { useTranslation } from 'react-i18next';

export function SwitchRunningSessionsDialog({
  modelId,
  pending,
  onConfirm,
  onClose,
}: {
  modelId: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('models.factoryDefault.confirmTitle', { model: formatModelName(modelId) })}</DialogTitle>
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
