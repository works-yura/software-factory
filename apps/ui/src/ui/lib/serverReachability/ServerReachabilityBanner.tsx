import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { CheckIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { installedServerReachability } from './serverReachability';
import type { ServerReachability } from './serverReachability';

/** Whole seconds until `at`, ticking each second while `at` is set. */
function useSecondsUntil(at: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [at]);
  return at === undefined ? undefined : Math.max(0, Math.ceil((at - now) / 1_000));
}

/**
 * Full-width row above every page while the server does not answer (it is restarting, or the
 * connection is gone), with a countdown to the next check and "Try now". When the server answers
 * again it says so for a moment; the page's queries resume on their own (`bindOnlineManager`).
 */
export function ServerReachabilityBanner({
  reachability = installedServerReachability(),
}: {
  reachability?: ServerReachability;
}) {
  return reachability ? <ReachabilityRow reachability={reachability} /> : null;
}

function ReachabilityRow({ reachability }: { reachability: ServerReachability }) {
  const { t } = useTranslation('app');
  const state = useSyncExternalStore(reachability.subscribe, reachability.getSnapshot);
  const seconds = useSecondsUntil(state.status === 'down' ? state.nextCheckAt : undefined);

  if (state.status === 'up') return null;

  if (state.status === 'back') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="border-surface-rim bg-success-subtle text-success-indicator flex shrink-0 items-center gap-3 border-b px-4 py-2"
      >
        <CheckIcon className="size-icon-md shrink-0" aria-hidden />
        <Txt as="span" variant="body-sm" tone="ink">
          {t('serverReachability.back')}
        </Txt>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-surface-rim bg-warning-subtle text-warning-indicator flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Spinner size="sm" aria-hidden="true" role="presentation" />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Txt as="h2" variant="label" tone="ink" className="shrink-0">
            {t('serverReachability.down')}
          </Txt>
          <Txt as="span" variant="body-sm" tone="muted">
            {state.checking || seconds === undefined || seconds === 0
              ? t('serverReachability.checking')
              : t('serverReachability.nextCheck', { count: seconds })}
          </Txt>
        </div>
      </div>
      <Button variant="default" size="sm" className="shrink-0" disabled={state.checking} onClick={() => reachability.checkNow()}>
        {t('serverReachability.tryNow')}
      </Button>
    </div>
  );
}
