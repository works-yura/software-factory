import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  addFirebaseAccount,
  checkFirebaseBinding,
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

/** Every write answers with the whole state, so the page shows exactly what the server keeps. */
export function useFirebaseMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const onSuccess = (state: FirebaseState) => queryClient.setQueryData(queryKeys.firebaseStatus(baseUrl), state);
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
