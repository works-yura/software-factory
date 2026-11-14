import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../../i18n';
import { translator } from '../../../../i18n/t';

import type {
  FactoryEnvironmentBuild,
  FactoryEnvironmentBuildStatus,
  FactoryEnvironmentLastBuild,
} from '../../../workspaces/services/environment';

const tk = translator('settings');

type BuildStatusVariant = 'neutral' | 'success' | 'destructive' | 'warning' | 'info';

/** A status badge whose label is translated when read. */
function buildStatus(label: () => string, variant: BuildStatusVariant): { readonly label: string; variant: BuildStatusVariant } {
  return {
    get label() {
      return label();
    },
    variant,
  };
}

export const BUILD_STATUS: Record<FactoryEnvironmentBuildStatus, { readonly label: string; variant: BuildStatusVariant }> = {
  pending: buildStatus(() => tk('environment.status.pending'), 'info'),
  building: buildStatus(() => tk('environment.status.building'), 'info'),
  ready: buildStatus(() => tk('environment.status.ready'), 'success'),
  failed: buildStatus(() => tk('environment.status.failed'), 'destructive'),
  unknown: buildStatus(() => tk('environment.status.unknown'), 'warning'),
};

export function formatBuildTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(currentLanguage());
}

/**
 * Build now beside the last build's live status; sits in the Template
 * subsection header. The error, when there is one, shows under the badge.
 */
export function BuildStatusBlock({
  lastBuild,
  build,
  requesting,
  onBuildNow,
}: {
  lastBuild: FactoryEnvironmentLastBuild | null | undefined;
  /** Live status of `lastBuild`; undefined while it loads or when there is no last build. */
  build: FactoryEnvironmentBuild | undefined;
  requesting: boolean;
  onBuildNow: () => void;
}) {
  const { t } = useTranslation('settings');
  const active = build?.status === 'pending' || build?.status === 'building';
  const status = build ? BUILD_STATUS[build.status] : lastBuild ? undefined : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {status === undefined ? (
          <span role="status" aria-label={t('environment.status.loading')}>
            <Skeleton aria-hidden className="h-5 w-16 rounded-full motion-reduce:before:animate-none" />
          </span>
        ) : status ? (
          <span className="flex items-center gap-2">
            <Badge size="sm" variant={status.variant}>
              {status.label}
            </Badge>
            {lastBuild?.attemptedAt && (
              <Txt as="span" variant="meta" tone="muted">
                {formatBuildTime(lastBuild.attemptedAt)}
              </Txt>
            )}
          </span>
        ) : null}
        <Button size="sm" variant="primary" disabled={requesting || active} onClick={onBuildNow}>
          {active ? t('environment.status.inProgress') : t('environment.status.buildNow')}
        </Button>
      </div>
      {build?.error && (
        <Txt as="span" font="mono" variant="meta" className="text-destructive max-w-96 truncate" title={build.error}>
          {build.error}
        </Txt>
      )}
    </div>
  );
}
