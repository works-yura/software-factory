import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode } from 'react';

type PreviewKind = 'share' | 'rows';

/** A static outline of the populated widget, without invented values: a segmented bar and its legend, or ranked rows. */
function PreviewShape({ kind }: { kind: PreviewKind }) {
  if (kind === 'share') {
    return (
      <>
        <rect x="0.5" y="0.5" width="118" height="22" rx="6" fill="var(--fill-subtle)" stroke="var(--border-strong)" strokeDasharray="4 4" />
        <rect x="122.5" y="0.5" width="70" height="22" rx="6" fill="var(--fill-subtle)" stroke="var(--border-strong)" strokeDasharray="4 4" />
        <rect x="196.5" y="0.5" width="43" height="22" rx="6" fill="var(--fill-subtle)" stroke="var(--border-strong)" strokeDasharray="4 4" />
        {[0, 1].map(row => (
          <g key={row} transform={`translate(0 ${40 + row * 26})`}>
            <rect x="0" y="0" width="2" height="16" rx="1" fill="var(--border-strong)" />
            <rect x="10" y="2" width="64" height="5" rx="2.5" fill="var(--fill)" />
            <rect x="10" y="10" width="28" height="4" rx="2" fill="var(--fill-subtle)" />
            <rect x="124" y="0" width="2" height="16" rx="1" fill="var(--border-strong)" />
            <rect x="134" y="2" width="56" height="5" rx="2.5" fill="var(--fill)" />
            <rect x="134" y="10" width="24" height="4" rx="2" fill="var(--fill-subtle)" />
          </g>
        ))}
      </>
    );
  }
  return (
    <>
      {[0, 1, 2, 3].map(row => (
        <g key={row} transform={`translate(0 ${6 + row * 24})`}>
          <rect x="0" y="2" width="44" height="5" rx="2.5" fill="var(--fill)" />
          <rect x="58" y="0.5" width="150" height="8" rx="4" fill="var(--fill-subtle)" stroke="var(--border-strong)" strokeDasharray="3 3" />
          <rect x="220" y="2" width="20" height="5" rx="2.5" fill="var(--fill-subtle)" />
        </g>
      ))}
    </>
  );
}

/**
 * A widget with nothing to show yet: a muted, dashed outline of what it will draw, with one short
 * status beside it (upstream's empty and low-data overview states).
 */
export function AnalyticsEmptyPreview({
  kind,
  title,
  description,
  action,
}: {
  kind: PreviewKind;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div data-testid="analytics-empty-preview" className="flex min-h-32 items-center gap-6 sm:gap-10">
      <svg aria-hidden="true" viewBox="0 0 240 96" className="w-28 shrink-0 text-placeholder sm:w-48">
        <PreviewShape kind={kind} />
      </svg>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Txt as="h4" variant="subheading" tone="muted" className="m-0">
          {title}
        </Txt>
        {description ? (
          <Txt as="p" variant="meta" tone="muted" className="m-0">
            {description}
          </Txt>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
