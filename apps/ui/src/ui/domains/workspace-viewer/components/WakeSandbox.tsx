import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionSandboxStartError } from '../../../../api/types';
import { useWorkspaceTree } from '../../../../hooks/use-fs';
import { useStartSessionSandbox } from '../../workspaces/hooks/useStartSessionSandbox';
import { SandboxStartRequestError } from '../../workspaces/services/user-sessions';

/** The start's failure as the page knows it: from the start request, else from the tree. */
function startFailure(requestError: Error | null, treeError?: SessionSandboxStartError): SessionSandboxStartError | undefined {
  if (requestError) {
    const code = requestError instanceof SandboxStartRequestError ? requestError.code : 'unknown';
    return { code, message: requestError.message };
  }
  return treeError;
}

/** Names a start failure in the viewer's language; the server's message stays as its detail. */
function StartFailure({ error }: { error: SessionSandboxStartError }) {
  const { t } = useTranslation('workspaces');
  return (
    <div role="alert" className="flex max-w-md flex-col items-center gap-1">
      <Txt as="span" variant="caption" className="text-destructive-foreground">
        {t(`wakeSandbox.errors.${error.code}`)}
      </Txt>
      {error.message ? (
        <Txt as="span" variant="caption" tone="muted" className="break-words">
          {error.message}
        </Txt>
      ) : null}
    </div>
  );
}

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
  const error = starting ? undefined : startFailure(start.error, tree.data?.startError);
  return (
    <div className="flex flex-col items-center gap-2">
      <Txt as="span" variant="caption" tone="muted">
        {starting ? t('wakeSandbox.starting') : t('wakeSandbox.notRunning')}
      </Txt>
      <Button size="sm" onClick={() => start.mutate()} disabled={starting}>
        {starting ? <Spinner size="sm" /> : <Power />}
        {starting ? t('wakeSandbox.waking') : t('wakeSandbox.wake')}
      </Button>
      {error ? <StartFailure error={error} /> : null}
    </div>
  );
}
