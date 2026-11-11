import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  addFirebaseAccount,
  checkFirebaseBinding,
  fetchFirebaseDatabases,
  fetchFirebaseProjects,
  fetchFirebaseState,
  removeFirebaseAccount,
  removeFirebaseBinding,
  saveFirebaseBinding,
  updateFirebaseAccount,
} from '../ui/domains/settings/services/firebase';
import type { FirebaseBindingInput, FirebaseState } from '../ui/domains/settings/services/firebase';

/** The org's Google Cloud accounts and the bindings that read through them. */
export function useFirebaseStateQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.firebaseStatus(baseUrl), queryFn: () => fetchFirebaseState(baseUrl) });
}

/** The projects an account can see (its key's own project always first); idle without an account. */
export function useFirebaseProjects(accountId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: ['firebase', 'projects', baseUrl, accountId] as const,
    queryFn: () => fetchFirebaseProjects(baseUrl, accountId!),
    enabled: Boolean(accountId),
    staleTime: 60_000,
  });
}

/** A project's Firestore databases through an account; idle until both are known. */
export function useFirebaseDatabases(accountId: string | undefined, projectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: ['firebase', 'databases', baseUrl, accountId, projectId] as const,
    queryFn: () => fetchFirebaseDatabases(baseUrl, accountId!, projectId!),
    enabled: Boolean(accountId && projectId),
    staleTime: 60_000,
  });
}

/** Every write answers with the whole state, so the page shows exactly what the server keeps. */
export function useFirebaseMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const onSuccess = (state: FirebaseState) => {
    queryClient.setQueryData(queryKeys.firebaseStatus(baseUrl), state);
    // Accounts fill MCP servers' inputs, and «База» bindings are MCP servers Google Cloud manages.
    void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
  };
  return {
    addAccount: useMutation({
      mutationFn: (input: { serviceAccountJson: string; name?: string }) => addFirebaseAccount(baseUrl, input),
      onSuccess,
    }),
    updateAccount: useMutation({
      mutationFn: ({ accountId, ...input }: { accountId: string; serviceAccountJson?: string; name?: string }) =>
        updateFirebaseAccount(baseUrl, accountId, input),
      onSuccess,
    }),
    removeAccount: useMutation({
      mutationFn: ({ accountId, withBindings }: { accountId: string; withBindings: boolean }) =>
        removeFirebaseAccount(baseUrl, accountId, withBindings),
      onSuccess,
    }),
    saveBinding: useMutation({
      mutationFn: (binding: FirebaseBindingInput & { id?: string }) => saveFirebaseBinding(baseUrl, binding),
      onSuccess,
    }),
    removeBinding: useMutation({ mutationFn: (bindingId: string) => removeFirebaseBinding(baseUrl, bindingId), onSuccess }),
    checkBinding: useMutation({ mutationFn: (binding: FirebaseBindingInput) => checkFirebaseBinding(baseUrl, binding) }),
  };
}
