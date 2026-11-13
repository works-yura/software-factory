import {
  Activity,
  ActivityDetail,
  ActivityHeader,
  ActivityIcon,
  ActivityLabel,
} from '@mastra/playground-ui/components/ai/activity';
import { AgentIndicator } from '@mastra/playground-ui/components/AgentIndicator';
import { Arriving } from '@mastra/playground-ui/components/Arrival';
import { useEffect, useState } from 'react';

import { sandboxSetupWords } from '../services/sandbox-setup';
import type { SandboxSetupState } from '../services/sandbox-setup';

/** Ticks once a second while the setup runs, so its time keeps moving between events. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * The session's sandbox setup in the run's own line: the step and repository in progress while
 * the turn waits on it, how long it took once ready, and which repository and step failed and why.
 */
export function SandboxSetupLine({ setup }: { setup: SandboxSetupState }) {
  const running = setup.status === 'running';
  const now = useNow(running);
  const { label, detail, title } = sandboxSetupWords(setup, now);
  const failed = setup.status === 'failed';

  return (
    <Arriving>
      <div role="status" data-testid="sandbox-setup-line" data-status={setup.status} title={title}>
        <Activity foldable={false} status={running ? 'running' : failed ? 'error' : 'idle'} appearance="inline">
          <ActivityHeader>
            <ActivityIcon className="[&_svg]:size-4">
              <AgentIndicator state={running ? 'running' : failed ? 'error' : 'done'} />
            </ActivityIcon>
            <ActivityLabel className="text-subheading">{label}</ActivityLabel>
            {detail && <ActivityDetail className="text-body-sm">{detail}</ActivityDetail>}
          </ActivityHeader>
        </Activity>
      </div>
    </Arriving>
  );
}
