import { Notice } from '@mastra/playground-ui/components/Notice';

import type { GithubStatusReason } from '../../services/github';
import { githubCallbackRecovery } from '../../services/githubCallbackRecovery';
import type { GithubCallbackRecovery } from '../../services/githubCallbackRecovery';
import { translator } from '../../../../i18n/t';
import type { GitHubAppCallbackResult } from '../GitHubAppCallbackHandler';

const tk = translator('workspaces');

export interface OnboardingGithubNoticeProps {
  callback?: GitHubAppCallbackResult;
  /** The latest GitHub status reason, kept while a refresh runs. */
  statusReason?: GithubStatusReason;
  /** Status has been read since this page loaded, so it reflects the install the callback reported. */
  statusChecked: boolean;
  /** Connect is on its way to GitHub; a second click would start another round trip. */
  redirecting: boolean;
  refreshing: boolean;
  onConnect: () => void;
  onConnectToken: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
}

/**
 * What the last GitHub App round trip did, with the step that gets the user unstuck. v4's own App reports
 * `?github=connected|error|no_app`; Platform's App never redirects here, so it has no notice of its own.
 */
export function OnboardingGithubNotice({
  callback,
  statusReason,
  statusChecked,
  redirecting,
  refreshing,
  onConnect,
  onConnectToken,
  onRefresh,
  onDismiss,
}: OnboardingGithubNoticeProps) {
  if (callback?.kind === 'error') {
    const recovery = githubCallbackRecovery(callback.code);
    const informational = recovery.next === 'refresh';
    return (
      <Notice
        variant={informational ? 'info' : 'destructive'}
        role={informational ? undefined : 'alert'}
        action={
          <>
            <CallbackNextAction
              next={recovery.next}
              redirecting={redirecting}
              refreshing={refreshing}
              onConnect={onConnect}
              onConnectToken={onConnectToken}
              onRefresh={onRefresh}
            />
            <DismissButton onDismiss={onDismiss} />
          </>
        }
      >
        {callback.message}
      </Notice>
    );
  }
  // Kept up even when other repositories already list: the request is for another account, still pending.
  if (callback?.kind === 'requested') {
    return (
      <Notice
        variant="warning"
        title={tk('onboarding.github.requestedTitle')}
        action={
          <>
            <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
            <DismissButton onDismiss={onDismiss} />
          </>
        }
      >
        {tk('onboarding.github.requestedBody')}
      </Notice>
    );
  }
  // GitHub reported an install, yet status (read since) has no usable one, e.g. the install gave the App
  // no repositories or was suspended. Say what was seen and offer both ways forward.
  if (callback?.kind === 'installed' && statusChecked && statusReason === 'not_connected') {
    return (
      <Notice
        variant="warning"
        role="alert"
        title={tk('onboarding.github.unseenTitle')}
        action={
          <>
            <Notice.Button disabled={redirecting} onClick={onConnect}>
              {tk('onboarding.github.chooseAnother')}
            </Notice.Button>
            <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
            <DismissButton onDismiss={onDismiss} />
          </>
        }
      >
        {tk('onboarding.github.unseenBody')}
      </Notice>
    );
  }
  return null;
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return <Notice.Button onClick={onDismiss}>{tk('onboarding.github.dismiss')}</Notice.Button>;
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Notice.Button disabled={refreshing} onClick={onRefresh}>
      {tk('actions.refresh')}
    </Notice.Button>
  );
}

function CallbackNextAction({
  next,
  redirecting,
  refreshing,
  onConnect,
  onConnectToken,
  onRefresh,
}: {
  next: GithubCallbackRecovery['next'];
  redirecting: boolean;
  refreshing: boolean;
  onConnect: () => void;
  onConnectToken: () => void;
  onRefresh: () => void;
}) {
  if (next === 'refresh') return <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />;
  if (next === 'token') return <Notice.Button onClick={onConnectToken}>{tk('vcs.connectWithToken')}</Notice.Button>;
  return (
    <Notice.Button disabled={redirecting} onClick={onConnect}>
      {tk('onboarding.github.connectAgain')}
    </Notice.Button>
  );
}
