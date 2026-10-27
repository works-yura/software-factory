import { useContext } from 'react';
import { useParams } from 'react-router';

import type { AvailableModelsTarget } from '../../../../hooks/useAvailableModels';
import { useFactoryProjectQuery } from '../../../../hooks/useFactoryDefaultModel';
import { useSessionModelCatalogQuery } from '../../../../hooks/useSessionModelCatalog';
import { ChatThreadMessagesContext } from './ChatThreadMessagesContext';
import { useChatSessionContext } from './useChatSessionContext';

/** Live threads use the same server-resolved policy as model invocations; drafts use the Factory's. */
export function useChatModelCatalog() {
  const { factoryId: routeFactoryId } = useParams<{ factoryId: string }>();
  const { factorySessionState, draftSessionId, sessionId, resourceId, sessionThreadId, resourceReady } =
    useChatSessionContext();
  // The displayed thread decides the policy; the session-primary thread is only a fallback.
  const displayedThreadId = useContext(ChatThreadMessagesContext)?.threadId;
  const factoryId = factorySessionState?.factoryProjectId ?? routeFactoryId;
  const projectQuery = useFactoryProjectQuery(factoryId);
  const sessionTarget = draftSessionId
    ? undefined
    : {
        factoryProjectId: factoryId,
        sessionId,
        resourceId,
        threadId: displayedThreadId ?? sessionThreadId ?? sessionId,
        enabled: resourceReady,
      };
  const sessionModelsQuery = useSessionModelCatalogQuery(sessionTarget);
  const catalogLoading = sessionTarget ? sessionModelsQuery.isPending : Boolean(factoryId && !projectQuery.isSuccess);
  const catalogTarget: AvailableModelsTarget = sessionTarget ?? { factoryProjectId: factoryId, enabled: !catalogLoading };

  return { factoryId, projectQuery, catalogTarget, catalogLoading, sessionModelsQuery };
}
