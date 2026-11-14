import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { EmptyFactoryState } from '../domains/workspaces';
import { callbackResult, GitHubAppCallbackHandler } from '../domains/workspaces/components/GitHubAppCallbackHandler';
import type { GitHubAppCallbackResult } from '../domains/workspaces/components/GitHubAppCallbackHandler';

/**
 * The GitHub App round trip lands here with its result in the query. Onboarding shows that result in place
 * (inline), with the step that gets the user unstuck, rather than a toast that leaves no way forward.
 */
export const OnboardingPage = () => {
  const [searchParams] = useSearchParams();
  // Read once on arrival: the handler strips the params right after.
  const [githubCallback, setGithubCallback] = useState<GitHubAppCallbackResult | undefined>(() =>
    callbackResult(searchParams),
  );
  return (
    <>
      <GitHubAppCallbackHandler inline />
      <EmptyFactoryState githubCallback={githubCallback} onDismissGithubCallback={() => setGithubCallback(undefined)} />
    </>
  );
};
