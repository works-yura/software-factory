import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import type { WorkspaceTreeListing } from '../../../../api/types';
import { startSessionSandbox } from '../services/user-sessions';

/**
 * Start a session's sandbox. The server answers at once and clones in the background: the tree's
 * root is marked starting so it polls (see `useWorkspaceTree`) until the sandbox runs or fails.
 */
export function useStartSessionSandbox(workspacePath: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['start-session-sandbox', workspacePath],
    mutationFn: () => startSessionSandbox(baseUrl, workspacePath),
    onSuccess: async ({ starting }) => {
      if (starting) {
        // Starting, not the stale "not running": the panel stays waking until the next poll answers.
        queryClient.setQueryData<WorkspaceTreeListing>(queryKeys.workspaceTree(workspacePath, ''), listing =>
          listing && !listing.available ? { ...listing, starting: true, startError: undefined } : listing,
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTreeScope(workspacePath) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaceChanges(workspacePath) }),
      ]);
    },
  });
}
