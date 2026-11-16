import { AssistantApiProvider, AssistantLauncher } from '@factory/assistant-ui';
import type { ReactNode } from 'react';

import { useApiConfig } from '../../../api/config';
import { useFactoryAuth } from '../../../hooks/useFactoryAuth';
import { assistantWorkspaceSlot } from './AssistantRequestFiles';

/** Settings › «Помічник»: the assistant's own page (personal), under a Factory's settings. */
export function assistantSettingsHref(factoryId: string): string {
  return `/factories/${encodeURIComponent(factoryId)}/settings/assistant`;
}

/**
 * The assistant's API at this app's server; with a Factory, the panel can link to its Account settings.
 * A request's workspace shows in the sessions' Files (`assistantWorkspaceSlot`).
 */
export function AssistantApi({ children, factoryId }: { children: ReactNode; factoryId?: string }) {
  const { baseUrl } = useApiConfig();
  return (
    <AssistantApiProvider
      baseUrl={baseUrl}
      workspace={assistantWorkspaceSlot}
      {...(factoryId ? { settingsHref: assistantSettingsHref(factoryId) } : {})}
    >
      {children}
    </AssistantApiProvider>
  );
}

/** Whether this person has an assistant: it lives in an organization, so only a signed-in person on a server with sign-in. */
export function useHasAssistant(): boolean {
  const auth = useFactoryAuth().data;
  return Boolean(auth?.authEnabled && auth.authenticated && auth.user?.organizationId);
}

/**
 * «Помічник» (ADR-0051) over every page: the floating button and its panel. The Factory the page
 * belongs to is the default target Factory for asking or handing over.
 */
export function AssistantOverlay({ factory }: { factory?: { id: string; name: string } }) {
  if (!useHasAssistant()) return null;
  return (
    <AssistantApi {...(factory ? { factoryId: factory.id } : {})}>
      <AssistantLauncher {...(factory ? { hint: factory } : {})} />
    </AssistantApi>
  );
}
