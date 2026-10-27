import { Txt } from '@mastra/playground-ui/components/Txt';

import type { WorkspaceChange } from '../../../../../api/types';
import { DiffStat } from '../../../../ui/DiffStat';

import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

export function ChangeCounts({
  additions,
  deletions,
  binary,
}: Pick<WorkspaceChange, 'additions' | 'deletions' | 'binary'>) {
  if (binary) {
    return (
      <Txt as="span" variant="meta" tone="muted" className="shrink-0">
        {tk('changes.binary')}
      </Txt>
    );
  }
  if (additions === undefined || deletions === undefined) return null;

  return (
    <Txt as="span" variant="meta" font="mono" className="shrink-0">
      <DiffStat additions={additions} deletions={deletions} />
    </Txt>
  );
}
