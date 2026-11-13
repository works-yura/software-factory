import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceTree } from '../../../../hooks/use-fs';
import { useStartSessionSandbox } from '../../workspaces/hooks/useStartSessionSandbox';

/**
 * Shown when the session has no running sandbox: start one on request. The start runs on the
 * server in the background; the tree's root reports it (and polls) while it runs, and why it
 * failed after, so a start begun elsewhere (another tab, a reload) shows here too.
 */
export function WakeSandbox({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation('workspaces');
  const start = useStartSessionSandbox(workspacePath);
  const tree = useWorkspaceTree(workspacePath, '');
  const starting = start.isPending || tree.data?.starting === true;
  const error = starting ? undefined : (start.error?.message ?? tree.data?.startError);
  return (
    <div className="flex flex-col items-center gap-2">
      <Txt as="span" variant="caption" tone="muted">
        {starting ? t('wakeSandbox.starting') : t('wakeSandbox.notRunning')}
      </Txt>
      <Button size="sm" onClick={() => start.mutate()} disabled={starting}>
        {starting ? <Spinner size="sm" /> : <Power />}
        {starting ? t('wakeSandbox.waking') : t('wakeSandbox.wake')}
      </Button>
      {error ? (
        <Txt as="span" variant="caption" className="text-destructive-foreground" role="alert">
          {error}
        </Txt>
      ) : null}
    </div>
  );
}
