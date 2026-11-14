import { Button } from '@mastra/playground-ui/components/Button';

import { GitLabIcon } from '../../../../ui/icons';
import { ProviderConnectControl } from '../../../settings/components/PlatformProviderConnections';
import { hostUnavailableDescription, isRecoverableHostReason } from '../../services/sourceControlHosts';
import type { HostUnavailableReason } from '../../services/sourceControlHosts';
import { translator } from '../../../../i18n/t';
import { OnboardingConnectionRow } from './OnboardingConnectionRow';
import { OnboardingHostRecoveryAction } from './OnboardingHostRecoveryAction';

const tk = translator('workspaces');

export function OnboardingGitlabHostRow({
  unavailableReason,
  retrying,
  onConnected,
  onRetry,
}: {
  unavailableReason?: HostUnavailableReason;
  retrying: boolean;
  onConnected: () => void;
  onRetry: () => void;
}) {
  return (
    <OnboardingConnectionRow
      name="GitLab"
      icon={<GitLabIcon />}
      description={
        unavailableReason ? hostUnavailableDescription('gitlab', unavailableReason) : tk('vcs.gitlabDescription')
      }
      tone={unavailableReason === 'unavailable' ? 'error' : 'muted'}
      action={
        <GitLabAction
          unavailableReason={unavailableReason}
          retrying={retrying}
          onConnected={onConnected}
          onRetry={onRetry}
        />
      }
    />
  );
}

function GitLabAction({
  unavailableReason,
  retrying,
  onConnected,
  onRetry,
}: {
  unavailableReason?: HostUnavailableReason;
  retrying: boolean;
  onConnected: () => void;
  onRetry: () => void;
}) {
  if (isRecoverableHostReason(unavailableReason)) {
    return (
      <OnboardingHostRecoveryAction host="gitlab" reason={unavailableReason} retrying={retrying} onRetry={onRetry} />
    );
  }
  if (unavailableReason) {
    return (
      <Button variant="default" disabled>
        {tk('vcs.connect', { host: 'GitLab' })}
      </Button>
    );
  }
  return (
    <ProviderConnectControl
      provider="gitlab"
      label={tk('vcs.connect', { host: 'GitLab' })}
      variant="default"
      size="md"
      onCompleted={onConnected}
    />
  );
}
