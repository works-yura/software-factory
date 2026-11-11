import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  checkFirebase,
  disconnectFirebase,
  fetchFirebaseMappings,
  fetchFirebaseStatus,
  saveFirebaseMapping,
  uploadFirebaseKey,
} from '../ui/domains/settings/services/firebase';
import type { FirebaseMapping } from '../ui/domains/settings/services/firebase';

export function useFirebaseStatusQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.firebaseStatus(baseUrl), queryFn: () => fetchFirebaseStatus(baseUrl) });
}

export function useFirebaseConnectionMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const onSuccess = (status: Awaited<ReturnType<typeof fetchFirebaseStatus>>) =>
    queryClient.setQueryData(queryKeys.firebaseStatus(baseUrl), status);
  return {
    upload: useMutation({ mutationFn: (json: string) => uploadFirebaseKey(baseUrl, json), onSuccess }),
    disconnect: useMutation({ mutationFn: () => disconnectFirebase(baseUrl), onSuccess }),
  };
}

export function useFirebaseMappingsQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.firebaseMappings(baseUrl), queryFn: () => fetchFirebaseMappings(baseUrl) });
}

export function useFirebaseMappingMutations(factoryId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return {
    save: useMutation({
      mutationFn: (mapping: FirebaseMapping | null) => saveFirebaseMapping(baseUrl, factoryId, mapping),
      onSuccess: mapping => {
        queryClient.setQueryData<Record<string, FirebaseMapping>>(queryKeys.firebaseMappings(baseUrl), current => {
          const next = { ...current };
          if (mapping) next[factoryId] = mapping;
          else delete next[factoryId];
          return next;
        });
      },
    }),
    check: useMutation({ mutationFn: (mapping: FirebaseMapping) => checkFirebase(baseUrl, factoryId, mapping) }),
  };
}
