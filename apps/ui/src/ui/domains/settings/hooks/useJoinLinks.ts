import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { createJoinLink, listJoinLinks, revokeJoinLink } from '../../auth/services/team';
import type { CreateJoinLinkInput } from '../../auth/services/team';

/** The organization's join links (admins only; the server refuses everyone else). */
export function useJoinLinks(organizationId: string) {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.joinLinks(organizationId), queryFn: () => listJoinLinks(baseUrl) });
}

export function useCreateJoinLink(organizationId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJoinLinkInput) => createJoinLink(baseUrl, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.joinLinks(organizationId) }),
  });
}

export function useRevokeJoinLink(organizationId: string, linkId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeJoinLink(baseUrl, linkId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.joinLinks(organizationId) }),
  });
}
