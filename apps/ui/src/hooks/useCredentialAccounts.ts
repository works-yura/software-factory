import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { CredentialAccountResponse, CredentialAccountsResponse } from '../api/types';

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
