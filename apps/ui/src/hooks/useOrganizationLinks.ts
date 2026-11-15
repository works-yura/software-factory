import { useMutation, useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  acceptInvitation,
  getInvitation,
  reloadIntoOrganization,
  rejectInvitation,
  setActiveOrganization,
} from '../ui/domains/auth/services/organization';
import { acceptJoinLink, previewJoinLink } from '../ui/domains/auth/services/team';

/**
 * The two ways into an organization from a link (ADR-0045): an invitation made for one email
 * (`/invite/:invitationId`) and a join link anyone allowed may open (`/join/:token`). Each reads what
 * the link offers and accepts it; accepting opens the app afresh in that organization, since nothing
 * cached from the previous one may stay on screen. A read never retries: a refused link stays refused.
 */

/** A join link: what it offers (organization, role, or why it refuses you) and joining through it. */
export function useJoinLink(token: string) {
  const { baseUrl } = useApiConfig();
  const preview = useQuery({
    queryKey: queryKeys.joinLinkPreview(token),
    queryFn: () => previewJoinLink(baseUrl, token),
    retry: false,
  });
  const accept = useMutation({
    // Joined (or already in): make it the session's organization, then open the app afresh in it.
    mutationFn: async () => {
      const joined = await acceptJoinLink(baseUrl, token);
      await setActiveOrganization(baseUrl, joined.organizationId);
    },
    onSuccess: () => reloadIntoOrganization(),
  });
  return { preview, accept };
}

/**
 * An invitation: who invited you where and with which role, accepting it (better-auth makes it the
 * session's organization in the same call) and declining it.
 */
export function useInvitation(invitationId: string) {
  const { baseUrl } = useApiConfig();
  const invitation = useQuery({
    queryKey: queryKeys.invitation(invitationId),
    queryFn: () => getInvitation(baseUrl, invitationId),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => acceptInvitation(baseUrl, invitationId),
    onSuccess: () => reloadIntoOrganization(),
  });
  const decline = useMutation({ mutationFn: () => rejectInvitation(baseUrl, invitationId) });
  return { invitation, accept, decline };
}
