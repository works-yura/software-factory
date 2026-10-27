import { Notice } from '@mastra/playground-ui/components/Notice';
import { RefreshCw } from 'lucide-react';
import { translator } from '../../../i18n/t';

const tk = translator('search');

// Session titles come from board cards, so only a board failure downgrades them to branch names
function failureMessage(boardFailed: boolean, intakeFailed: boolean): string {
  if (!boardFailed) return tk('status.intakeFailed');
  if (!intakeFailed) return tk('status.boardFailed');
  return tk('status.boardAndIntakeFailed');
}

export function GlobalSearchWorkItemsStatus({
  boardFailed,
  intakeFailed,
  onRetry,
}: {
  boardFailed: boolean;
  intakeFailed: boolean;
  onRetry: () => void;
}) {
  if (!boardFailed && !intakeFailed) return null;

  return (
    <div className="px-3 py-2">
      <Notice
        variant="warning"
        action={
          <Notice.Button onClick={onRetry}>
            {tk('status.retry')} <RefreshCw />
          </Notice.Button>
        }
      >
        {failureMessage(boardFailed, intakeFailed)}
      </Notice>
    </div>
  );
}
