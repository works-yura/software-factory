import type { AvailableModelOption } from '../../../../hooks/useAvailableModels';
import { useAvailableModelsQuery } from '../../../../hooks/useAvailableModels';

export interface ProviderModels {
  isPending: boolean;
  /** The catalog is being fetched again, e.g. after Retry. */
  retrying: boolean;
  catalogError?: Error;
  models: AvailableModelOption[];
  /** What the Factory starts on unless the user picks another model. */
  suggestedModelId?: string;
  retry: () => void;
}

function preferredFactoryModel(providerId: string): string | undefined {
  switch (providerId) {
    case 'openai':
      return 'openai/gpt-5.6-sol';
    case 'anthropic':
      return 'anthropic/claude-fable-5';
    default:
      return undefined;
  }
}

/** The models a connected provider offers, with the one a Factory should start on. */
export function useProviderModels(providerId: string | undefined): ProviderModels {
  const modelsQuery = useAvailableModelsQuery();
  const models = (modelsQuery.data ?? []).filter(model => model.provider === providerId);
  const preferredModelId = providerId ? preferredFactoryModel(providerId) : undefined;

  return {
    isPending: modelsQuery.isPending,
    retrying: modelsQuery.isFetching,
    catalogError: modelsQuery.error ?? undefined,
    models,
    // Unknown until the catalog answers: a fallback chosen sooner would be submitted by Create.
    suggestedModelId: modelsQuery.isPending
      ? undefined
      : (models.find(model => model.id === preferredModelId)?.id ?? models[0]?.id),
    retry: () => {
      void modelsQuery.refetch();
    },
  };
}
