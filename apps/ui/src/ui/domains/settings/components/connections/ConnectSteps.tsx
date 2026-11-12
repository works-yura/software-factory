import { Button } from '@mastra/playground-ui/components/Button';
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionIcon } from './ConnectionIcon';

/** Where a pick leads: a connection's page (`?connection=`). */
export type ConnectionTarget = { connection: string };

/**
 * The header and footer every connect step shares: the connector's logo, its title and one line;
 * «← Назад» and the step's action. Every string comes from the connector the server describes.
 */
export function StepFrame({
  kind,
  children,
  onBack,
  action,
  title,
  subtitle,
}: {
  /** The connector's logo key. */
  kind: string;
  children: ReactNode;
  onBack: () => void;
  action?: ReactNode;
  title: string;
  subtitle: string;
}) {
  const { t } = useTranslation('settings');
  return (
    <>
      <DialogHeader className="flex-row items-start gap-2.5">
        <ConnectionIcon kind={kind} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-body-sm">{subtitle}</DialogDescription>
        </span>
      </DialogHeader>
      <DialogBody className="gap-4">{children}</DialogBody>
      <DialogFooter className="mt-auto justify-between pt-3 max-sm:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          {t('connections.connect.back')}
        </Button>
        {action}
      </DialogFooter>
    </>
  );
}
