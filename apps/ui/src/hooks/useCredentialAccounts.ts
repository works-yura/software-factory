import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { AccountSignInResponse, CredentialAccountResponse, CredentialAccountsResponse } from '../api/types';

/**
 * Accounts a provider's runs rotate through (`anthropic` for Claude Code,
 * `openai-codex` for Codex): the members' own sign-ins.
 */
function accountsPath(provider: string, id?: string): string {
  const base = `/web/config/providers/${encodeURIComponent(provider)}/accounts`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export function useCredentialAccountsQuery(provider: string) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.credentialAccounts(provider),
    queryFn: () => client.get<CredentialAccountsResponse>(accountsPath(provider)),
    retry: false,
  });
}

function useInvalidateAccounts(provider: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.credentialAccounts(provider) });
}

export interface UpdateCredentialAccountArgs {
  id: string;
  label?: string;
  disabled?: boolean;
}

export function useUpdateCredentialAccount(provider: string) {
  const { client } = useApiConfig();
  const invalidate = useInvalidateAccounts(provider);
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateCredentialAccountArgs) =>
      client.patch<CredentialAccountResponse>(accountsPath(provider, id), patch),
    onSuccess: invalidate,
  });
}

export function useRemoveCredentialAccount(provider: string) {
  const { client } = useApiConfig();
  const invalidate = useInvalidateAccounts(provider);
  return useMutation({
    mutationFn: (id: string) => client.del<{ ok: true }>(accountsPath(provider, id)),
    onSuccess: invalidate,
  });
}

/** How often a pending sign-in is asked about while the person finishes it in the browser. */
export const ACCOUNT_SIGN_IN_POLL_MS = 1_500;

/**
 * A sign-in: `start` asks the server to run the provider's sign-in (`claude
 * auth login`, whose page opens on the server's machine; Codex's device
 * sign-in, whose page and code the flow carries as `prompt`); the flow is then
 * polled until it is done (the accounts list refreshes) or failed. `cancel`
 * stops it.
 */
export function useAccountSignIn(provider: string) {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => client.post<AccountSignInResponse>(`${accountsPath(provider)}/sign-in`, {}),
    onSuccess: response => setId(response.signIn.id),
  });
  const flow = useQuery({
    queryKey: queryKeys.accountSignIn(provider, id),
    queryFn: () => client.get<AccountSignInResponse>(`${accountsPath(provider)}/sign-in/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: query => (query.state.data?.signIn.status === 'pending' ? ACCOUNT_SIGN_IN_POLL_MS : false),
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: () => client.del<{ cancelled: boolean }>(`${accountsPath(provider)}/sign-in/${encodeURIComponent(id!)}`),
    onSettled: () => void flow.refetch(),
  });
  const status = flow.data?.signIn.status ?? (start.isPending || (id !== null && flow.isPending) ? 'pending' : undefined);
  // The account the sign-in filed shows up in the list.
  useEffect(() => {
    if (status === 'done') void queryClient.invalidateQueries({ queryKey: queryKeys.credentialAccounts(provider) });
  }, [status, queryClient, provider]);
  return {
    start: () => start.mutate(),
    cancel: () => cancel.mutate(),
    status,
    signIn: flow.data?.signIn,
    error: start.error ?? flow.error ?? null,
  };
}
