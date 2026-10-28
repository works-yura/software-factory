import { useKeydown } from '@mastra/playground-ui/keyboard/use-keydown';
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { useApiConfig } from '../../../../../api/config';
import { useGithubReposQuery } from '../../../../../hooks/useGithubRepos';
import { useGithubStatusQuery } from '../../../../../hooks/useGithubStatus';
import { useServerFeatures } from '../../../../../hooks/useServerFeatures';
import { createFactorySteps, useCreateFactoryFlow } from '../../hooks/useCreateFactoryFlow';
import type { CreateFactoryFlowStep } from '../../hooks/useCreateFactoryFlow';
import { useCreateFactoryFromDraft } from '../../hooks/useCreateFactoryFromDraft';
import { factoryHomePath } from '../../services/factoryPaths';
import { connectGithub, manageGithubConnection } from '../../services/github';
import type { FactoryHarness } from '../../services/github';
import { CreateFactoryClaudeCodeStep } from './CreateFactoryClaudeCodeStep';
import { CreateFactoryHarnessRows } from './CreateFactoryHarnessRows';
import { CreateFactoryModelStep } from './CreateFactoryModelStep';
import { CreateFactoryNameRows } from './CreateFactoryNameRows';
import { CreateFactoryPalette } from './CreateFactoryPalette';
import { CreateFactoryRepositoryRows } from './CreateFactoryRepositoryRows';
import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

interface StepChrome {
  title: string;
  placeholder: string;
  searchable?: boolean;
}

function stepChrome(step: CreateFactoryFlowStep, harness: FactoryHarness | undefined): StepChrome {
  switch (step) {
    case 'name':
      return {
        title: tk('createFactory.steps.name.title'),
        placeholder: tk('createFactory.steps.name.placeholder'),
        searchable: false,
      };
    case 'harness':
      return {
        title: tk('createFactory.steps.harness.title'),
        placeholder: tk('createFactory.steps.harness.placeholder'),
        searchable: false,
      };
    case 'vcs':
      return { title: tk('createFactory.steps.vcs.title'), placeholder: tk('createFactory.steps.vcs.placeholder') };
    case 'model-provider':
      if (harness === 'claude-code') {
        return {
          title: tk('createFactory.steps.claudeCode.title'),
          placeholder: tk('createFactory.steps.claudeCode.placeholder'),
        };
      }
      return {
        title: tk('createFactory.steps.modelProvider.title'),
        placeholder: tk('createFactory.steps.modelProvider.placeholder'),
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : tk('createFactory.genericError');
}

/**
 * Name → Harness → VCS → Model provider (no harness step when the server only
 * runs Mastra; for Claude Code the last step picks a Claude model instead of a
 * provider). Every pick stays in the
 * draft until the model step commits it, so the Factory only exists once the
 * user finished the wizard.
 */
export function CreateFactoryWizard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { baseUrl } = useApiConfig();
  const flow = useCreateFactoryFlow();
  const [githubRedirecting, setGithubRedirecting] = useState(false);
  const [typed, setTyped] = useState<{ step: CreateFactoryFlowStep; value: string }>();

  const draft = flow.draft;
  // The repository list loads while the name is still being typed, so the next step has rows on arrival.
  const githubStatus = useGithubStatusQuery();
  const features = useServerFeatures();
  // Until the server says otherwise there is nothing to choose: Factories run on Mastra.
  // A draft resumed on the harness step keeps it in view even if the flag is still loading.
  const harnessChoice = features.data?.claudeCode === true || draft?.step === 'harness';
  const steps = createFactorySteps({ harnessChoice });
  useGithubReposQuery(undefined, draft?.step === 'name' && githubStatus.data?.connected === true);

  const createFactory = useCreateFactoryFromDraft({
    draft,
    onFactoryCreated: factory => flow.rememberFactory(factory),
    onRepositoryLinked: linkedRepositoryId => flow.rememberLinkedRepository(linkedRepositoryId),
    onCreated: async factory => {
      await flow.clear();
      void navigate(factoryHomePath(factory));
    },
  });

  const committing = createFactory.isPending;

  const leave = () => {
    if (location.key === 'default') void navigate(factoryId ? `/factories/${factoryId}` : '/');
    else void navigate(-1);
  };
  useKeydown({ Escape: leave }, { enabled: !committing, insideFields: true });

  const step = draft?.step;
  if (!step) return null;

  // Each step starts from its own field value — the name step from the name already given.
  const typedOnThisStep = typed?.step === step ? typed.value : undefined;
  const value = typedOnThisStep ?? (step === 'name' ? (draft.name ?? '') : '');

  return (
    <div className="flex min-h-0 flex-col gap-2 pt-6">
      <CreateFactoryPalette
        {...stepChrome(step, draft.harness)}
        step={step}
        steps={steps}
        value={value}
        onValueChange={nextValue => setTyped({ step, value: nextValue })}
        onBack={
          // Once the final commit has written any server state (a Factory row or
          // a linked repository), stepping back would let the user pick a new
          // name or repository while the retry still resumes the prior IDs, so
          // the Back affordance is dropped until the wizard completes.
          step === 'name' || committing || Boolean(draft.factoryId) || Boolean(draft.linkedRepositoryId)
            ? undefined
            : () => {
                setTyped(undefined);
                void flow.back({ harnessChoice });
              }
        }
      >
        {step === 'name' && (
          <CreateFactoryNameRows
            name={value}
            // Hold the name until the server says whether there is a harness to pick.
            disabled={features.isPending}
            onSubmit={name => void flow.submitName(name, { harnessChoice })}
          />
        )}
        {step === 'harness' && (
          <CreateFactoryHarnessRows selected={draft.harness} onSelect={harness => void flow.chooseHarness(harness)} />
        )}
        {step === 'vcs' && (
          <CreateFactoryRepositoryRows
            query={value}
            githubRedirecting={githubRedirecting}
            onConnect={() => {
              setGithubRedirecting(true);
              flow.persistBeforeRedirect(factoryId);
              connectGithub(baseUrl);
            }}
            onManageConnection={() => {
              flow.persistBeforeRedirect(factoryId);
              manageGithubConnection(baseUrl);
            }}
            onSelectRepository={repository => void flow.chooseRepository(repository)}
          />
        )}
        {step === 'model-provider' && draft.harness === 'claude-code' && (
          <CreateFactoryClaudeCodeStep
            query={value}
            saving={
              createFactory.isPending && createFactory.variables && 'claudeCodeModel' in createFactory.variables
                ? { model: createFactory.variables.claudeCodeModel }
                : undefined
            }
            error={createFactory.error ? errorMessage(createFactory.error) : undefined}
            onPick={claudeCodeModel => createFactory.mutate({ claudeCodeModel })}
          />
        )}
        {step === 'model-provider' && draft.harness !== 'claude-code' && (
          <CreateFactoryModelStep
            query={value}
            savingModelId={
              createFactory.isPending && createFactory.variables && 'modelId' in createFactory.variables
                ? createFactory.variables.modelId
                : undefined
            }
            error={createFactory.error ? errorMessage(createFactory.error) : undefined}
            onPick={(_providerId, modelId) => createFactory.mutate({ modelId })}
          />
        )}
      </CreateFactoryPalette>
    </div>
  );
}
