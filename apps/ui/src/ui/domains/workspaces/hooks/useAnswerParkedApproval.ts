import { toast } from '@mastra/playground-ui/components/Toaster';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { answerParkedApproval } from '../services/user-sessions';

/** Answers the tool call a followed card's phase session waits on, from the row of the session following it. */
export function useAnswerParkedApproval(factoryId: string, sessionId: string | undefined) {
  const { t } = useTranslation('workspaces');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const mutationKey = ['answer-parked-approval', sessionId];
  const answering = useIsMutating({ mutationKey }) > 0;
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: (decision: 'approve' | 'decline') => {
      if (!sessionId) throw new Error(t('sessionRow.answerFailed'));
      return answerParkedApproval(baseUrl, sessionId, decision);
    },
    onSuccess: (_, decision) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workItems(factoryId) });
      toast(decision === 'approve' ? t('sessionRow.approved') : t('sessionRow.declined'));
    },
    onError: error => toast.error(error instanceof Error ? error.message : t('sessionRow.answerFailed')),
  });
  return { answer: sessionId ? mutate : undefined, answering };
}
