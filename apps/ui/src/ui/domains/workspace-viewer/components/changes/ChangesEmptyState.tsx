import { Txt } from '@mastra/playground-ui/components/Txt';

import { WakeSandbox } from '../WakeSandbox';

import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export function ChangesEmptyState({
  workspacePath,
  sandboxRunning,
}: {
  workspacePath: string;
  sandboxRunning: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
      {sandboxRunning ? (
        <Txt tone="muted" variant="caption">
          {tk('overview.noChanges')}
        </Txt>
      ) : (
        <WakeSandbox workspacePath={workspacePath} />
      )}
    </div>
  );
}
