import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

/** A repository list that failed to load or refresh: its error, with Retry. */
export function OnboardingRepositoryError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 ps-3">
      <Txt variant="caption" role="alert" className="text-destructive-foreground m-0">
        {message}
      </Txt>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying && <Spinner size="sm" aria-hidden="true" />}
        {tk('actions.retry')}
      </Button>
    </div>
  );
}
