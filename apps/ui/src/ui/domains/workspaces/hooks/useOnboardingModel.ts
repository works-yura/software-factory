import type { ProviderInfo } from '../../../../api/types';
import type { OnboardingDraft, OnboardingModelChoice } from '../services/onboardingFlow';
import { useProviderConnection } from './useProviderConnection';
import type { ProviderConnection } from './useProviderConnection';
import { useProviderModels } from './useProviderModels';
import type { ProviderModels } from './useProviderModels';

/** Why the saved provider no longer works: it left the provider list, or its connection is gone. */
export type SavedProviderProblem = 'gone' | 'changed';

export interface OnboardingModel {
  connection: ProviderConnection;
  /** The provider whose models are offered: the one picked and connected. */
  connectedProvider?: ProviderInfo;
  models: ProviderModels;
  /** The model the combobox shows: the user's pick, else the provider's suggestion. Empty while unknown. */
  modelId: string;
  /** The user picked a model this provider no longer offers. */
  previousUnavailable: boolean;
  /** What Create submits for the company account; undefined until a provider is connected and a model known. */
  choice?: OnboardingModelChoice;
  savedProblem?: SavedProviderProblem;
}

/**
 * The company account's provider and model on the onboarding page. A provider is chosen only once its key or
 * sign-in succeeds, and every pick lands in the draft right away, so a page restored after a sign-in redirect
 * shows the same choice. The model Create submits is the user's pick, else the provider's suggestion.
 */
export function useOnboardingModel({
  draft,
  onDraftChange,
}: {
  draft: OnboardingDraft;
  onDraftChange: (patch: Partial<OnboardingDraft>) => void;
}): OnboardingModel {
  const connection = useProviderConnection({
    scope: 'org',
    initialSelection: draft.model && { providerId: draft.model.providerId, method: draft.model.method },
    onSelectionChange: selection =>
      // A new provider has no model picked yet: the empty id keeps the provider while its suggestion stands.
      onDraftChange({ model: selection && { ...selection, modelId: '' } }),
  });
  const connectedProvider = connection.connected ? connection.provider : undefined;
  const models = useProviderModels(connectedProvider?.provider);
  const picked = draft.model?.providerId === connectedProvider?.provider ? draft.model?.modelId || undefined : undefined;
  const pickedOffered = picked !== undefined && models.models.some(model => model.id === picked);
  const previousUnavailable = picked !== undefined && !models.isPending && !pickedOffered;
  const modelId = pickedOffered ? picked : previousUnavailable ? '' : (models.suggestedModelId ?? '');
  const choice =
    connectedProvider && connection.method && modelId
      ? { providerId: connectedProvider.provider, method: connection.method, modelId }
      : undefined;
  const savedProblem = savedProviderProblem(connection, draft);
  return { connection, connectedProvider, models, modelId, previousUnavailable, choice, savedProblem };
}

/** A saved provider that no longer works says why instead of reopening as a blank picker. */
function savedProviderProblem(connection: ProviderConnection, draft: OnboardingDraft): SavedProviderProblem | undefined {
  if (!draft.model || connection.isPending || connection.catalogError) return undefined;
  if (connection.selectedProviderId !== draft.model.providerId) return undefined;
  if (!connection.provider) return 'gone';
  if (!connection.connected) return 'changed';
  return undefined;
}
