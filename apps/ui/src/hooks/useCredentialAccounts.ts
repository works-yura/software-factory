import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { ClaudeSignInResponse, CredentialAccountResponse, CredentialAccountsResponse } from '../api/types';

/**
 * Accounts a provider's runs rotate through (today only `anthropic`, for
 * Claude Code): the organization's API keys and members' own subscriptions.
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

export interface AddCredentialAccountArgs {
  label: string;
  secret: string;
}

export function useAddCredentialAccount(provider: string) {
  const { client } = useApiConfig();
  const invalidate = useInvalidateAccounts(provider);
  return useMutation({
    mutationFn: (args: AddCredentialAccountArgs) =>
      client.post<CredentialAccountResponse>(accountsPath(provider), args),
    onSuccess: invalidate,
  });
}

export interface UpdateCredentialAccountArgs {
  id: string;
  label?: string;
  secret?: string;
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

/** How often a pending Claude sign-in is asked about while the person finishes it in the browser. */
export const CLAUDE_SIGN_IN_POLL_MS = 1_500;

/**
 * A Claude sign-in: `start` asks the server to run `claude auth login`, whose
 * page opens in the browser on the server's machine; the flow is then polled
 * until it is done (the accounts list refreshes) or failed. `cancel` stops it.
 */
export function useClaudeSignIn(provider: string) {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => client.post<ClaudeSignInResponse>(`${accountsPath(provider)}/sign-in`, {}),
    onSuccess: response => setId(response.signIn.id),
  });
  const flow = useQuery({
    queryKey: queryKeys.claudeSignIn(id),
    queryFn: () => client.get<ClaudeSignInResponse>(`${accountsPath(provider)}/sign-in/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    refetchInterval: query => (query.state.data?.signIn.status === 'pending' ? CLAUDE_SIGN_IN_POLL_MS : false),
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
