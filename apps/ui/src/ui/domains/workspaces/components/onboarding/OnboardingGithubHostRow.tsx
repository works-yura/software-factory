import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';

import { hostUnavailableDescription, isRecoverableHostReason } from '../../services/sourceControlHosts';
import type { HostUnavailableReason } from '../../services/sourceControlHosts';
import { translator } from '../../../../i18n/t';
import { OnboardingConnectionRow } from './OnboardingConnectionRow';
import { OnboardingHostRecoveryAction } from './OnboardingHostRecoveryAction';

const tk = translator('workspaces');

export function OnboardingGithubHostRow({
  redirecting,
  unavailableReason,
  appConfigured,
  retrying,
  onConnect,
  onConnectToken,
  onRetry,
}: {
  redirecting: boolean;
  unavailableReason?: HostUnavailableReason;
  /** False when this server has no GitHub App: Connect would only bounce back, so a token connects instead. */
  appConfigured: boolean;
  retrying: boolean;
  onConnect: () => void;
  onConnectToken: () => void;
  onRetry: () => void;
}) {
  const description = unavailableReason
    ? hostUnavailableDescription('github', unavailableReason)
    : appConfigured
      ? tk('vcs.githubDescription')
      : tk('vcs.githubNoApp');
  return (
    <OnboardingConnectionRow
      name="GitHub"
      icon={<GithubIcon />}
      description={description}
      tone={unavailableReason === 'unavailable' ? 'error' : 'muted'}
      action={
        isRecoverableHostReason(unavailableReason) ? (
          <OnboardingHostRecoveryAction
            host="github"
            reason={unavailableReason}
            retrying={retrying}
            onRetry={onRetry}
          />
        ) : appConfigured || unavailableReason ? (
          <Button variant="default" disabled={redirecting || unavailableReason !== undefined} onClick={onConnect}>
            {redirecting && <Spinner size="sm" aria-label={tk('vcs.connectingGithub')} />}
            {tk('vcs.connect', { host: 'GitHub' })}
          </Button>
        ) : (
          <Button variant="default" onClick={onConnectToken}>
            {tk('vcs.connectWithToken')}
          </Button>
        )
      }
    />
  );
}
