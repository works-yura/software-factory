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
import { Input } from '@mastra/playground-ui/components/Input';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** «Перейменувати»: one name field; saving an unchanged or empty name is not offered. */
export function RenameDialog({
  name,
  pending,
  onSave,
  onClose,
}: {
  name: string;
  pending: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState(name);
  const next = value.trim();
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('connections.rename.title', { name })}</DialogTitle>
          <DialogDescription className="sr-only">{t('connections.rename.label')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="connection-rename"
            onSubmit={event => {
              event.preventDefault();
              if (next && next !== name) onSave(next);
            }}
          >
            <Input aria-label={t('connections.rename.label')} value={value} autoFocus onChange={event => setValue(event.target.value)} />
          </form>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('connections.rename.cancel')}
          </Button>
          <Button size="sm" type="submit" form="connection-rename" disabled={!next || next === name || pending}>
            {t('connections.rename.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A yes/no for «Відв'язати» and «Видалити»: what goes, what stays. */
export function ConfirmDialog({
  title,
  body,
  confirm,
  cancel,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {cancel}
          </Button>
          <Button size="sm" disabled={pending} onClick={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
