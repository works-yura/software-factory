import { cn } from '@mastra/playground-ui/utils/cn';

import { translator } from '../i18n/t';

const tk = translator('workspaces');

export interface DiffStatProps {
  additions: number;
  deletions: number;
  className?: string;
}

/** Copy of `@mastra/playground-ui` DiffStat from upstream 7573972d0c, newer than the published 65.0.0. */
export function DiffStat({ additions, deletions, className }: DiffStatProps) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 tabular-nums', className)}>
      <span aria-hidden="true" className="text-success-indicator">
        +{additions}
      </span>
      <span aria-hidden="true" className="text-destructive-foreground">
        −{deletions}
      </span>
      <span className="sr-only">
        {tk('changes.countsLabel', {
          additions: tk('changes.additions', { count: additions }),
          deletions: tk('changes.deletions', { count: deletions }),
        })}
      </span>
    </span>
  );
}
