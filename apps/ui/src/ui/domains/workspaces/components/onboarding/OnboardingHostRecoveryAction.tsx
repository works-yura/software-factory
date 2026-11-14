import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Link } from 'react-router';

import { HOST_NAMES } from '../../services/sourceControlHosts';
import type { RecoverableHostReason, SourceControlHost } from '../../services/sourceControlHosts';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

/** Sign-in returns here, so the draft kept in this tab picks up where it stopped. */
const SIGN_IN_PATH = `/signin?returnTo=${encodeURIComponent('/onboarding')}`;

/** The way out of a host problem that Connect can't fix: Retry a failed status, or sign in again. */
export function OnboardingHostRecoveryAction({
  host,
  reason,
  retrying,
  onRetry,
}: {
  host: SourceControlHost;
  reason: RecoverableHostReason;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (reason === 'auth_required') {
    return (
      <Button variant="default" render={<Link to={SIGN_IN_PATH} />}>
        {tk('onboarding.signIn')}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      aria-label={tk('vcs.retryHost', { host: HOST_NAMES[host] })}
      disabled={retrying}
      onClick={onRetry}
    >
      {retrying && <Spinner size="sm" aria-hidden="true" />}
      {tk('actions.retry')}
    </Button>
  );
}
