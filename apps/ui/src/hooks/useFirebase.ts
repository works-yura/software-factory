import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { addFirebaseAccount } from '../ui/domains/settings/services/firebase';

/**
 * Adds a Google Cloud service account to the organization from an MCP server's form. Accounts fill
 * MCP servers' inputs and appear in Google Cloud's connect methods, so both are read again.
 */
export function useAddGoogleCloudAccount() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { serviceAccountJson: string; name?: string }) => addFirebaseAccount(baseUrl, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
        queryClient.invalidateQueries({ queryKey: ['connections'] }),
      ]),
  });
}
