import { toast } from '@mastra/playground-ui/components/Toaster';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

import { queryKeys } from '../../../../api/keys';
import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

const handledCallbackKeys = new Set<string>();
const callbackParamNames = [
  'github_app_installed',
  'github_app_requested',
  'github_app_user_authorized',
  'github_app_error',
  'installation_id',
  'setup_action',
];

// Codes Mastra Platform's GitHub App callback redirects back with when it
// refuses to link an installation or a GitHub account.
const CALLBACK_ERROR_CODES = [
  'github_app_installation_preexisting',
  'github_app_installation_not_owned',
  'github_app_installation_linked_elsewhere',
  'github_app_sign_in_required',
  'github_app_session_mismatch',
  'github_app_person_not_platform_user',
  'github_app_link_already_used',
  'github_app_link_not_started_here',
  'github_app_connection_mismatch',
  'github_app_user_authorization_required',
  'github_app_user_authorization_failed',
] as const;

const callbackErrorMessages: Readonly<Record<string, string>> = lazyLabels(
  CALLBACK_ERROR_CODES,
  code => `workspaces:githubCallback.errors.${code}`,
);

function callbackErrorMessage(code: string | null): string | undefined {
  return code && Object.hasOwn(callbackErrorMessages, code) ? callbackErrorMessages[code] : undefined;
}

function hasGitHubAppCallback(searchParams: URLSearchParams): boolean {
  return callbackParamNames.some(name => searchParams.has(name));
}

export function GitHubAppCallbackHandler() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!hasGitHubAppCallback(searchParams)) return;

    const callbackKey = searchParams.toString();
    if (handledCallbackKeys.has(callbackKey)) return;
    handledCallbackKeys.add(callbackKey);

    const requested = searchParams.get('github_app_requested') === 'true';
    const installed = searchParams.get('github_app_installed') === 'true';
    const userAuthorized = searchParams.get('github_app_user_authorized') === 'true';
    const failed = searchParams.has('github_app_error');
    const errorMessage = callbackErrorMessage(searchParams.get('github_app_error'));

    void queryClient.invalidateQueries({ queryKey: queryKeys.githubStatus() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.factories() });

    // The route tree mounts before the app-level Toaster sibling in main.tsx.
    // Defer one microtask so the toaster's own passive effects subscribe before
    // this callback emits a notification on initial page load.
    queueMicrotask(() => {
      if (requested) {
        toast.success(tk('githubCallback.requested'));
      } else if (installed) {
        toast.success(tk('githubCallback.installed'));
      } else if (userAuthorized) {
        toast.success(tk('githubCallback.userAuthorized'));
      } else if (errorMessage) {
        // These explain what to do next, so keep them up until dismissed.
        toast.error(errorMessage, { duration: Infinity });
      } else if (failed) {
        toast.error(tk('githubCallback.failed'));
      }
    });

    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        for (const name of callbackParamNames) {
          next.delete(name);
        }
        return next;
      },
      { replace: true },
    );
  }, [queryClient, searchParams, setSearchParams]);

  return null;
}
