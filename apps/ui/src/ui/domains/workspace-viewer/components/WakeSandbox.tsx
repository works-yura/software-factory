import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useStartSessionSandbox } from '../../workspaces/hooks/useStartSessionSandbox';

/** Shown when the session has no running sandbox: start one on request. */
export function WakeSandbox({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation('workspaces');
  const start = useStartSessionSandbox(workspacePath);
  return (
    <div className="flex flex-col items-center gap-2">
      <Txt as="span" variant="caption" tone="muted">
        {t('wakeSandbox.notRunning')}
      </Txt>
      <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? <Spinner size="sm" /> : <Power />}
        {start.isPending ? t('wakeSandbox.waking') : t('wakeSandbox.wake')}
      </Button>
      {start.error ? (
        <Txt as="span" variant="caption" className="text-destructive-foreground">
          {start.error.message}
        </Txt>
      ) : null}
    </div>
  );
}
