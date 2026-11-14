import { toast } from '@mastra/playground-ui/components/Toaster';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';
import { useSearchParams } from 'react-router';

import { queryKeys } from '../../../../api/keys';
import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

const handledCallbackKeys = new Set<string>();
const callbackParamNames = [
  // This server's own GitHub App callback: `connected`, `error`, or `no_app` (no App configured).
  'github',
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

export type GitHubAppCallbackResult =
  | { kind: 'requested' }
  | { kind: 'installed' }
  | { kind: 'user_authorized' }
  | { kind: 'error'; code?: string; message: string };

/** The result a GitHub App callback URL reports; undefined when the URL carries none. */
export function callbackResult(searchParams: URLSearchParams): GitHubAppCallbackResult | undefined {
  const own = searchParams.get('github');
  if (own === 'connected') return { kind: 'installed' };
  if (own === 'no_app') return { kind: 'error', code: 'no_app', message: tk('githubCallback.noApp') };
  if (own === 'error') return { kind: 'error', code: 'connect_failed', message: tk('githubCallback.connectFailed') };
  if (searchParams.get('github_app_requested') === 'true') return { kind: 'requested' };
  if (searchParams.get('github_app_installed') === 'true') return { kind: 'installed' };
  if (searchParams.get('github_app_user_authorized') === 'true') return { kind: 'user_authorized' };
  const code = searchParams.get('github_app_error');
  if (code !== null) return { kind: 'error', code, message: callbackErrorMessage(code) ?? tk('githubCallback.failed') };
  return undefined;
}

function toastCallbackResult(result: GitHubAppCallbackResult): void {
  switch (result.kind) {
    case 'requested':
      toast.success(tk('githubCallback.requested'));
      return;
    case 'installed':
      toast.success(tk('githubCallback.installed'));
      return;
    case 'user_authorized':
      toast.success(tk('githubCallback.userAuthorized'));
      return;
    case 'error':
      // Mapped messages explain what to do next, so keep them up until dismissed.
      toast.error(result.message, result.message === tk('githubCallback.failed') ? undefined : { duration: Infinity });
  }
}

/**
 * Refreshes GitHub data and strips the callback params. With `inline`, the page reads the result itself
 * (`callbackResult`) and shows it in place, so nothing toasts; otherwise every result is a toast.
 */
export function GitHubAppCallbackHandler({ inline = false }: { inline?: boolean } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const reportResult = useEffectEvent((result: GitHubAppCallbackResult) => {
    if (inline) return;
    // The route tree mounts before the app-level Toaster sibling in main.tsx.
    // Defer one microtask so the toaster's own passive effects subscribe before
    // this callback emits a notification on initial page load.
    queueMicrotask(() => toastCallbackResult(result));
  });

  useEffect(() => {
    if (!hasGitHubAppCallback(searchParams)) return;

    const callbackKey = searchParams.toString();
    if (handledCallbackKeys.has(callbackKey)) return;
    handledCallbackKeys.add(callbackKey);

    const result = callbackResult(searchParams);

    void queryClient.invalidateQueries({ queryKey: queryKeys.githubStatus() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.factories() });

    if (result) reportResult(result);

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
