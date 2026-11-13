import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { RefreshCwIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { installedBuildFreshness } from './buildFreshness';
import type { BuildFreshness } from './buildFreshness';

/**
 * Full-width row above every page once the server serves a newer build than this page runs: what
 * this page does may no longer match the server, so it asks for a reload instead of failing later.
 */
export function BuildFreshnessBanner({
  freshness = installedBuildFreshness(),
  reload = () => window.location.reload(),
}: {
  freshness?: BuildFreshness;
  reload?: () => void;
}) {
  return freshness ? <FreshnessRow freshness={freshness} reload={reload} /> : null;
}

function FreshnessRow({ freshness, reload }: { freshness: BuildFreshness; reload: () => void }) {
  const { t } = useTranslation('app');
  const stale = useSyncExternalStore(freshness.subscribe, freshness.getSnapshot);
  if (!stale) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-surface-rim bg-info-subtle text-info-indicator flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <RefreshCwIcon className="size-icon-md shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Txt as="h2" variant="label" tone="ink" className="shrink-0">
            {t('buildFreshness.stale')}
          </Txt>
          <Txt as="span" variant="body-sm" tone="muted">
            {t('buildFreshness.detail')}
          </Txt>
        </div>
      </div>
      <Button variant="default" size="sm" className="shrink-0" onClick={reload}>
        {t('buildFreshness.reload')}
      </Button>
    </div>
  );
}
