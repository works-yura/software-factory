import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { WorkspaceChanges } from '../../../../api/types';
import { useRecreateSessionSandbox } from '../../workspaces/hooks/useRecreateSessionSandbox';
import type { RecreateSandboxTarget } from '../../workspaces/hooks/useRecreateSessionSandbox';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export type { RecreateSandboxTarget };

interface RecreateSandboxActionProps {
  target: RecreateSandboxTarget;
  changes?: WorkspaceChanges;
  changesLoading: boolean;
  changesError?: Error;
}

function changesWarning({ changes, changesLoading, changesError }: Omit<RecreateSandboxActionProps, 'target'>) {
  if (changesLoading) return tk('recreateSandbox.checkingChanges');
  // A stuck sandbox often can't report its changes, so assume they exist.
  if (changesError || !changes?.available) return tk('recreateSandbox.changesUnknown');
  const count = changes.changes.length;
  if (count === 0) return undefined;
  return tk('recreateSandbox.changesLost', { count });
}

export function RecreateSandboxAction({ target, ...changesState }: RecreateSandboxActionProps) {
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  const recreate = useRecreateSessionSandbox(target, { onSuccess: () => setOpen(false) });
  const warning = changesWarning(changesState);

  const setDialogOpen = (next: boolean) => {
    if (recreate.isPending) return;
    if (next) recreate.reset();
    setOpen(next);
  };

  return (
    <>
      <Button className="w-full justify-start" size="sm" variant="ghost" onClick={() => setDialogOpen(true)}>
        <RotateCcw />
        <span>{t('recreateSandbox.action')}</span>
      </Button>
      <AlertDialog open={open} onOpenChange={setDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('recreateSandbox.title')}</AlertDialog.Title>
            <AlertDialog.Description>{t('recreateSandbox.description')}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Body className="flex flex-col gap-1">
            {warning ? <Txt variant="body-sm">{warning}</Txt> : null}
            <Txt variant="body-sm">{t('recreateSandbox.agentStops')}</Txt>
            {recreate.error ? (
              <Txt variant="body-sm" className="text-destructive-foreground" role="alert">
                {recreate.error.message}
              </Txt>
            ) : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={recreate.isPending}>{t('actions.cancel')}</AlertDialog.Cancel>
            <Button variant="destructive" size="md" disabled={recreate.isPending} onClick={() => recreate.mutate()}>
              {recreate.isPending ? t('recreateSandbox.recreating') : t('recreateSandbox.confirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
