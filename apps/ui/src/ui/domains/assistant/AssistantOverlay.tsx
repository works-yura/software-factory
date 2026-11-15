import { AssistantApiProvider, AssistantLauncher, AssistantSettings, AssistantSources } from '@factory/assistant-ui';
import type { ReactNode } from 'react';

import { useApiConfig } from '../../../api/config';
import { useFactoryAuth } from '../../../hooks/useFactoryAuth';

/** Account › «Помічник» (its model picker) under a Factory's settings. */
export function assistantSettingsHref(factoryId: string): string {
  return `/factories/${encodeURIComponent(factoryId)}/settings/account#assistant`;
}

/** The assistant's API at this app's server; with a Factory, the panel can link to its Account settings. */
export function AssistantApi({ children, factoryId }: { children: ReactNode; factoryId?: string }) {
  const { baseUrl } = useApiConfig();
  return (
    <AssistantApiProvider baseUrl={baseUrl} {...(factoryId ? { settingsHref: assistantSettingsHref(factoryId) } : {})}>
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

/** Account › «Помічник» › «Джерела»: the person's own source connections (ClickUp Chat), invisible to Factories. */
export function AssistantAccountSources() {
  return (
    <AssistantApi>
      <AssistantSources />
    </AssistantApi>
  );
}

/** Account › «Помічник»: the person's own settings, invisible to Factories. */
export function AssistantAccountSettings() {
  return (
    <AssistantApi>
      <AssistantSettings />
    </AssistantApi>
  );
}
