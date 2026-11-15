import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import {
  cancelInvitation,
  getOrganization,
  inviteMember,
  leaveOrganization,
  reloadIntoOrganization,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from '../../auth/services/organization';
import type { AssignableRole } from '../../auth/services/organization';

/**
 * The organization the person works in, active in their session: its id, the full organization
 * (members, invitations), whether auth offers organizations at all, and the person's membership.
 */
export function useActiveOrganization() {
  const { baseUrl } = useApiConfig();
  const auth = useFactoryAuth();
  const organizationId = auth.data?.user?.organizationId;
  const userId = auth.data?.user?.userId;
  const available = auth.data?.provider === 'better-auth' && Boolean(organizationId);
  const organization = useQuery({
    queryKey: queryKeys.organization(organizationId),
    queryFn: () => {
      if (!organizationId) throw new Error('No active organization to load');
      return getOrganization(baseUrl, organizationId);
    },
    enabled: available,
  });
  const me = organization.data?.members.find(member => member.userId === userId);
  return { auth, organization, available, userId, me };
}

/** Reloads the organization (members, invitations) after a change. */
function useRefreshOrganization(organizationId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId) });
}

/** Renames the organization or changes its avatar; the switcher lists show the new name too. */
export function useUpdateOrganization(organizationId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name?: string; logo?: string | null }) => updateOrganization(baseUrl, organizationId, data),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizations() }),
      ]),
  });
}

/** Leaves the organization and reloads into the next one the person belongs to. */
export function useLeaveOrganization(organizationId: string) {
  const { baseUrl } = useApiConfig();
  return useMutation({
    mutationFn: () => leaveOrganization(baseUrl, organizationId),
    onSuccess: () => reloadIntoOrganization(),
  });
}

export function useRemoveMember(organizationId: string, memberId: string) {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(organizationId);
  return useMutation({ mutationFn: () => removeMember(baseUrl, organizationId, memberId), onSuccess: refresh });
}

export function useChangeMemberRole(organizationId: string, memberId: string) {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(organizationId);
  return useMutation({
    mutationFn: (role: AssignableRole) => updateMemberRole(baseUrl, organizationId, memberId, role),
    onSuccess: refresh,
  });
}

/** better-auth makes the invitation; Factory shows its link to copy (no email is sent). */
export function useInviteMember(organizationId: string) {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(organizationId);
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: AssignableRole }) => inviteMember(baseUrl, organizationId, email, role),
    onSuccess: refresh,
  });
}

export function useCancelInvitation(organizationId: string, invitationId: string) {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(organizationId);
  return useMutation({ mutationFn: () => cancelInvitation(baseUrl, invitationId), onSuccess: refresh });
}
