import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { avatarDataUrl, currentSession, listSessions, revokeOtherSessions, revokeSession, updateProfile, uploadAvatar } from '../../auth/services/team';

/** Changes the person's own name or picture (better-auth `update-user`), then rereads `/auth/me`. */
export function useUpdateProfile() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name?: string; image?: string | null }) => updateProfile(baseUrl, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.factoryAuth() }),
  });
}

/**
 * An avatar from a picked file: cropped and scaled to 256 px in the browser, uploaded, and its URL
 * handed to `save` (`null` removes it). A file the browser cannot read fails with `unsupported`.
 */
export function useAvatarUpload(save: (url: string | null) => Promise<unknown>, unsupported: string) {
  const { baseUrl } = useApiConfig();
  return useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return save(null);
      let dataUrl: string;
      try {
        dataUrl = await avatarDataUrl(file);
      } catch {
        throw new Error(unsupported);
      }
      const { url } = await uploadAvatar(baseUrl, dataUrl);
      return save(url);
    },
  });
}

/** Where the person is signed in, and which of those sessions is this browser's. */
export function useSignInSessions() {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.signInSessions(),
    queryFn: async () => {
      const [list, current] = await Promise.all([listSessions(baseUrl), currentSession(baseUrl)]);
      return { list, currentId: current?.session.id };
    },
  });
}

export function useRevokeSession(token: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeSession(baseUrl, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signInSessions() }),
  });
}

export function useRevokeOtherSessions() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeOtherSessions(baseUrl),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signInSessions() }),
  });
}
