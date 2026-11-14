import { useMutation, useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { listOrganizations, reloadIntoOrganization, setActiveOrganization } from '../ui/domains/auth/services/organization';

/**
 * The organizations the signed-in person belongs to (better-auth's own list). Shared by Settings ›
 * Організація and the sidebar's organization menu, so both read one cached list.
 */
export function useOrganizationsQuery({ enabled = true }: { enabled?: boolean } = {}) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.organizations(),
    queryFn: () => listOrganizations(baseUrl),
    enabled,
  });
}

/**
 * Makes another organization the active one and opens the app afresh in it: factories, boards and
 * settings all belong to the organization, so nothing cached from the previous one may stay on screen.
 */
export function useSwitchOrganizationMutation() {
  const { baseUrl } = useApiConfig();
  return useMutation({
    mutationFn: (organizationId: string) => setActiveOrganization(baseUrl, organizationId),
    onSuccess: () => reloadIntoOrganization(),
  });
}
