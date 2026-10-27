import { Txt } from '@mastra/playground-ui/components/Txt';

import type { WorkspaceChange, WorkspacePatchOmission } from '../../../../../../api/types';
import { ChangeCounts } from '../ChangeCounts';
import { hasTextChanges } from './has-text-changes';

import { translator } from '../../../../../i18n/t';

const tk = translator('workspaces');

const OMISSION_LABEL_KEYS = {
  'file-too-large': 'changes.omitted.fileTooLarge',
  'total-too-large': 'changes.omitted.totalTooLarge',
} as const satisfies Record<WorkspacePatchOmission, string>;

interface FileLineSummaryProps {
  change: WorkspaceChange;
  patch?: string;
  omission?: WorkspacePatchOmission;
}

export function FileLineSummary({ change, patch, omission }: FileLineSummaryProps) {
  if (patch === undefined) {
    return (
      <Txt as="span" variant="meta" tone="muted">
        {omission ? tk(OMISSION_LABEL_KEYS[omission]) : tk('changes.diffUnavailable')}
      </Txt>
    );
  }
  if (!change.binary && !hasTextChanges(change)) return null;
  return <ChangeCounts {...change} />;
}
