import { useState } from 'react';

import { useOnboardingModel } from '../../../hooks/useOnboardingModel';
import type { OnboardingDraft, OnboardingModelChoice } from '../../../services/onboardingFlow';
import { ModelProviderFactoryStep } from '../../ModelProviderFactoryStep';

/**
 * Onboarding's Model section as the page drives it: picks land in a draft, and a stand-in for the page's
 * Create button submits the model Create would (enabled only once there is one).
 */
export function ModelSection({
  initialDraft = {},
  onComplete,
}: {
  initialDraft?: OnboardingDraft;
  onComplete: (choice: OnboardingModelChoice) => void;
}) {
  const [draft, setDraft] = useState<OnboardingDraft>(initialDraft);
  const model = useOnboardingModel({ draft, onDraftChange: patch => setDraft(current => ({ ...current, ...patch })) });
  return (
    <>
      <ModelProviderFactoryStep
        model={model}
        onModelChange={modelId => {
          if (model.connectedProvider && model.connection.method)
            setDraft(current => ({
              ...current,
              model: { providerId: model.connectedProvider!.provider, method: model.connection.method!, modelId },
            }));
        }}
      />
      <button type="button" disabled={!model.choice} onClick={() => model.choice && onComplete(model.choice)}>
        Create factory
      </button>
    </>
  );
}
