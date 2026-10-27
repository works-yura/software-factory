import { toast } from '@mastra/playground-ui/components/Toaster';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { regenerateSessionTitle } from '../services/user-sessions';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export function useRegenerateSessionTitle(factoryId: string, sessionId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const mutationKey = ['regenerate-session-title', sessionId];
  const regenerating = useIsMutating({ mutationKey }) > 0;
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: () => regenerateSessionTitle(baseUrl, sessionId),
    onSuccess: title => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions(factoryId) });
      toast(tk('sessionRow.renamed', { title }));
    },
    onError: error => toast.error(error instanceof Error ? error.message : tk('sessionRow.regenerateFailed')),
  });
  return { regenerate: () => mutate(), regenerating };
}
